// auth_provision_internal_test.go — Tier 2 (testcontainers) coverage for findOrCreateUser,
// the race-safe just-in-time user provisioner in the Auth middleware.
//
// White-box (package middleware) so it can call the unexported helper directly against a real
// Postgres schema — the race it guards against only exists with true unique constraints +
// GORM's TranslateError, which the ephemeral container reproduces exactly (same GormConfig as
// prod). Regression anchor: GOLF-LEAGUE-BACKEND-4 / -FRONTEND-P (2026-07-20), where a new
// user's parallel first-load requests collided on INSERT and one 500'd with "failed to create
// user record".
package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/trentd187/golf-league/internal/models"
	"github.com/trentd187/golf-league/internal/testutil"
)

// testJWTSecret + testKeyfunc mint and verify HS256 tokens for the end-to-end middleware test.
// validateToken doesn't pin a signing method — it trusts whatever the keyfunc validates — so a
// symmetric key is enough to exercise the full JWT→DB provisioning path without a JWKS server.
var testJWTSecret = []byte("test-secret-do-not-use-in-prod")

func testKeyfunc(_ *jwt.Token) (interface{}, error) { return testJWTSecret, nil }

// mintToken signs a Supabase-shaped JWT (sub + email + user_metadata) for the given identity.
func mintToken(t *testing.T, authID, email, fullName string) string {
	t.Helper()
	claims := &Claims{
		RegisteredClaims: jwt.RegisteredClaims{Subject: authID},
		Email:            email,
		UserMetadata:     map[string]interface{}{"full_name": fullName},
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(testJWTSecret)
	require.NoError(t, err)
	return signed
}

// TestMakeAuthHandler_ProvisionsThenReuses drives the full middleware against a real DB with a
// valid token: the first request provisions the users row (created path), the second finds and
// reuses it (sync path) — both 200, same userID. Covers the handler's DB glue that the Tier 1
// nil-DB tests can't reach.
func TestMakeAuthHandler_ProvisionsThenReuses(t *testing.T) {
	db := testutil.NewTestDB(t)

	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Get("/me", MakeAuthHandler(testKeyfunc, db), func(c *fiber.Ctx) error {
		return c.SendString(c.Locals("userID").(string))
	})

	const authID = "55555555-5555-5555-5555-555555555555"
	token := mintToken(t, authID, "e2e@example.com", "E2E User")

	call := func() (int, string) {
		req := httptest.NewRequest(http.MethodGet, "/me", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := app.Test(req, -1)
		require.NoError(t, err)
		buf := make([]byte, resp.ContentLength)
		_, _ = resp.Body.Read(buf)
		return resp.StatusCode, string(buf)
	}

	status1, id1 := call()
	assert.Equal(t, http.StatusOK, status1)
	assert.NotEmpty(t, id1)

	status2, id2 := call()
	assert.Equal(t, http.StatusOK, status2)
	assert.Equal(t, id1, id2, "the second request must reuse the provisioned row")

	var count int64
	require.NoError(t, db.Model(&models.User{}).Where("auth_id = ?", authID).Count(&count).Error)
	assert.Equal(t, int64(1), count)

	var got models.User
	require.NoError(t, db.Where("auth_id = ?", authID).First(&got).Error)
	assert.Equal(t, "E2E User", got.DisplayName)
}

// TestFindOrCreateUser_ConcurrentFirstLoad is the core race repro: N goroutines provision the
// same brand-new auth_id at once (the parallel first-load burst). Every call must succeed and
// return the SAME user id, and exactly one row must exist. Without the ErrDuplicatedKey
// refetch, the losers return gorm.ErrDuplicatedKey and this fails.
func TestFindOrCreateUser_ConcurrentFirstLoad(t *testing.T) {
	db := testutil.NewTestDB(t)
	ctx := context.Background()

	const authID = "11111111-1111-1111-1111-111111111111"
	const email = "race@example.com"

	const n = 8
	start := make(chan struct{}) // release all goroutines together to maximize contention
	var wg sync.WaitGroup
	ids := make([]string, n)
	errs := make([]error, n)

	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			u, _, _, err := findOrCreateUser(ctx, db, authID, email, "Racer", nil)
			errs[i] = err
			if err == nil {
				ids[i] = u.ID.String()
			}
		}(i)
	}
	close(start)
	wg.Wait()

	for i := 0; i < n; i++ {
		require.NoErrorf(t, errs[i], "goroutine %d should not error on a lost create race", i)
		assert.NotEmpty(t, ids[i], "goroutine %d should return a user id", i)
		assert.Equal(t, ids[0], ids[i], "all callers must resolve to the same winning row")
	}

	var count int64
	require.NoError(t, db.Model(&models.User{}).Where("auth_id = ?", authID).Count(&count).Error)
	assert.Equal(t, int64(1), count, "exactly one users row should exist for the auth_id")
}

// TestFindOrCreateUser_CreatesWhenAbsent covers the plain first-sign-in path: no row yet →
// created=true, row persisted with the JWT-derived fields.
func TestFindOrCreateUser_CreatesWhenAbsent(t *testing.T) {
	db := testutil.NewTestDB(t)
	ctx := context.Background()

	const authID = "22222222-2222-2222-2222-222222222222"
	avatar := "https://example.com/a.jpg"

	u, created, tag, err := findOrCreateUser(ctx, db, authID, "new@example.com", "Newbie", &avatar)
	require.NoError(t, err)
	assert.Empty(t, tag)
	assert.True(t, created, "a fresh auth_id should be created")
	assert.Equal(t, "Newbie", u.DisplayName)
	assert.Equal(t, models.UserRoleUser, u.Role)
	require.NotNil(t, u.AvatarURL)
	assert.Equal(t, avatar, *u.AvatarURL)

	var count int64
	require.NoError(t, db.Model(&models.User{}).Where("auth_id = ?", authID).Count(&count).Error)
	assert.Equal(t, int64(1), count)
}

// TestFindOrCreateUser_ReturnsExisting covers the returning-user path: the row is found on the
// first lookup → created=false (so the caller runs the field-sync branch), no second insert.
func TestFindOrCreateUser_ReturnsExisting(t *testing.T) {
	db := testutil.NewTestDB(t)
	ctx := context.Background()

	authID := "33333333-3333-3333-3333-333333333333"
	existing := models.User{AuthID: &authID, DisplayName: "Existing", Email: "existing@example.com", Role: models.UserRoleUser}
	require.NoError(t, db.Create(&existing).Error)

	u, created, tag, err := findOrCreateUser(ctx, db, authID, "existing@example.com", "ignored", nil)
	require.NoError(t, err)
	assert.Empty(t, tag)
	assert.False(t, created, "an existing user must not be reported as created")
	assert.Equal(t, existing.ID, u.ID)
}

// TestFindOrCreateUser_LookupFaultPropagates covers the genuine-DB-fault path: a non-NotFound
// error from the lookup must propagate with the auth.lookup_user tag (so the handler 500s and
// ErrorLogger raises a Sentry Issue) — a lost race is absorbed, a real fault is not.
func TestFindOrCreateUser_LookupFaultPropagates(t *testing.T) {
	db := testutil.NewTestDB(t)

	cancelled, cancel := context.WithCancel(context.Background())
	cancel() // a cancelled context makes the query fail with a non-ErrRecordNotFound error

	_, created, tag, err := findOrCreateUser(cancelled, db, "44444444-4444-4444-4444-444444444444", "x@example.com", "X", nil)
	require.Error(t, err)
	assert.False(t, created)
	assert.Equal(t, "auth.lookup_user", tag)
	assert.NotErrorIs(t, err, gorm.ErrRecordNotFound)
}
