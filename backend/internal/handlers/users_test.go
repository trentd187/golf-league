// users_test.go
// Unit tests for the user handlers in users.go.
//
// Strategy: Tier 1 only — tests cover validation paths that return before any
// DB call, so nil can be safely passed as *gorm.DB.
//
// All new handlers (SearchUsers, GetUserProfile, GetUserStats, FollowUser,
// UnfollowUser, GetFollowing) parse the caller's userID from c.Locals("userID")
// via uuid.Parse. Without auth middleware that local is "", so uuid.Parse("") fails
// and the handler returns 401 before touching the DB.
//
// Additional Tier 1 paths:
//   - Invalid `:userId` path param → 400 (uuid.Parse fails before DB lookup)
//   - FollowUser with callerID == targetID → 400 (self-follow guard)
//
// Paths that require a real DB (Tier 2, not yet implemented):
//   - Actual follow/unfollow writes, search results, stats computation
//
// Run:
//
//	go test ./internal/handlers/ -run TestUser -v
//	go test ./internal/handlers/ -run TestGetMe -v
//	go test ./internal/handlers/ -run TestSearch -v
//	go test ./internal/handlers/ -run TestFollow -v
package handlers_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/handlers"
)

// newUserAppWithAuth builds a minimal Fiber app with a stub auth middleware that
// injects a valid userID local. Use for tests that need to reach past the auth
// check but return before any DB call (e.g. invalid UUID param).
func newUserAppWithAuth(method, path string, handler fiber.Handler) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("userID", validUUID)
		return c.Next()
	})
	app.Add(method, path, handler)
	return app
}

// ─── GetMe ────────────────────────────────────────────────────────────────────

// TestGetMe_NoAuth_Unauthorized verifies that GET /api/v1/me returns 401 when no
// userID has been injected into the request context (i.e. no auth middleware ran).
// This exercises the `!ok || callerIDStr == ""` guard at the top of GetMe.
func TestGetMe_NoAuth_Unauthorized(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/api/v1/me", handlers.GetMe(nil))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/v1/me", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// ─── SearchUsers ──────────────────────────────────────────────────────────────

// TestSearchUsers_MissingAuth verifies GET /users returns 401 without auth context.
func TestSearchUsers_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/users", handlers.SearchUsers(nil))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/users", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// ─── GetUserProfile ───────────────────────────────────────────────────────────

// TestGetUserProfile_MissingAuth verifies GET /users/:userId returns 401 without auth context.
func TestGetUserProfile_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/users/:userId", handlers.GetUserProfile(nil))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/users/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// TestGetUserProfile_InvalidUserID verifies GET /users/:userId returns 400
// for a malformed UUID before any DB call.
func TestGetUserProfile_InvalidUserID(t *testing.T) {
	app := newUserAppWithAuth(http.MethodGet, "/users/:userId", handlers.GetUserProfile(nil))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/users/not-a-uuid", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── GetUserStats ─────────────────────────────────────────────────────────────

// TestGetUserStats_MissingAuth verifies GET /users/:userId/stats returns 401 without auth.
func TestGetUserStats_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/users/:userId/stats", handlers.GetUserStats(nil))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/users/"+validUUID+"/stats", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// TestGetUserStats_InvalidUserID verifies GET /users/:userId/stats returns 400
// for a malformed UUID before any DB call.
func TestGetUserStats_InvalidUserID(t *testing.T) {
	app := newUserAppWithAuth(http.MethodGet, "/users/:userId/stats", handlers.GetUserStats(nil))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/users/not-a-uuid/stats", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── FollowUser ───────────────────────────────────────────────────────────────

// TestFollowUser_MissingAuth verifies POST /users/:userId/follow returns 401 without auth.
func TestFollowUser_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, "/users/:userId/follow", handlers.FollowUser(nil))

	resp, err := app.Test(httptest.NewRequest(http.MethodPost, "/users/"+validUUID+"/follow", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// TestFollowUser_InvalidUserID verifies POST /users/:userId/follow returns 400
// for a malformed UUID before any DB call.
func TestFollowUser_InvalidUserID(t *testing.T) {
	app := newUserAppWithAuth(http.MethodPost, "/users/:userId/follow", handlers.FollowUser(nil))

	resp, err := app.Test(httptest.NewRequest(http.MethodPost, "/users/not-a-uuid/follow", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestFollowUser_CannotFollowSelf verifies POST /users/:userId/follow returns 400
// when the caller and target are the same user. This check runs before any DB call.
func TestFollowUser_CannotFollowSelf(t *testing.T) {
	// Both the injected userID local and the path param are the same validUUID,
	// so the self-follow guard fires before touching the DB (nil is safe here).
	app := newUserAppWithAuth(http.MethodPost, "/users/:userId/follow", handlers.FollowUser(nil))

	resp, err := app.Test(httptest.NewRequest(http.MethodPost, "/users/"+validUUID+"/follow", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── UnfollowUser ─────────────────────────────────────────────────────────────

// TestUnfollowUser_MissingAuth verifies DELETE /users/:userId/follow returns 401 without auth.
func TestUnfollowUser_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodDelete, "/users/:userId/follow", handlers.UnfollowUser(nil))

	resp, err := app.Test(httptest.NewRequest(http.MethodDelete, "/users/"+validUUID+"/follow", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// TestUnfollowUser_InvalidUserID verifies DELETE /users/:userId/follow returns 400
// for a malformed UUID before any DB call.
func TestUnfollowUser_InvalidUserID(t *testing.T) {
	app := newUserAppWithAuth(http.MethodDelete, "/users/:userId/follow", handlers.UnfollowUser(nil))

	resp, err := app.Test(httptest.NewRequest(http.MethodDelete, "/users/not-a-uuid/follow", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── GetFollowing ─────────────────────────────────────────────────────────────

// TestGetFollowing_MissingAuth verifies GET /users/following returns 401 without auth.
func TestGetFollowing_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/users/following", handlers.GetFollowing(nil))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/users/following", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// ─── GetUserRounds ────────────────────────────────────────────────────────────

// TestGetUserRounds_MissingAuth verifies GET /users/:userId/rounds returns 401 without auth.
func TestGetUserRounds_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/users/:userId/rounds", handlers.GetUserRounds(nil))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/users/"+validUUID+"/rounds", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// TestGetUserRounds_InvalidUserID verifies GET /users/:userId/rounds returns 400
// for a malformed UUID before any DB call.
func TestGetUserRounds_InvalidUserID(t *testing.T) {
	app := newUserAppWithAuth(http.MethodGet, "/users/:userId/rounds", handlers.GetUserRounds(nil))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/users/not-a-uuid/rounds", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestGetUsers_AvatarURL_RequiresTier2 documents that the old GetUsers handler was
// replaced by SearchUsers. SearchUsers hits the DB for the user list, so its full
// response shape (including avatar_url and is_following) can only be verified in
// Tier 2 tests (real DB). The search filter and is_following batch query also require Tier 2.
func TestGetUsers_AvatarURL_RequiresTier2(t *testing.T) {
	t.Skip("SearchUsers (formerly GetUsers) hits the DB before returning results — full response shape requires Tier 2 (real DB)")
}

// ─── computeHandicapPair ──────────────────────────────────────────────────────
// computeHandicapPair is a pure function — all paths are Tier 1 (no DB).

// TestComputeHandicapPair_NilSlice verifies that a nil input returns (nil, nil).
func TestComputeHandicapPair_NilSlice(t *testing.T) {
	hi, ah := handlers.ComputeHandicapPairExported(nil)
	assert.Nil(t, hi)
	assert.Nil(t, ah)
}

// TestComputeHandicapPair_TwoRounds verifies that fewer than 3 differentials
// returns (nil, nil) — not enough data for a meaningful index.
func TestComputeHandicapPair_TwoRounds(t *testing.T) {
	hi, ah := handlers.ComputeHandicapPairExported([]float64{10.0, 12.0})
	assert.Nil(t, hi)
	assert.Nil(t, ah)
}

// TestComputeHandicapPair_ThreeRounds verifies that exactly 3 differentials
// (the minimum) produces non-nil results and uses all 3 for both hi and ah.
func TestComputeHandicapPair_ThreeRounds(t *testing.T) {
	// diffs: [8.0, 12.0, 16.0] sorted → best=8, worst=16 (use=3, all three for both)
	hi, ah := handlers.ComputeHandicapPairExported([]float64{16.0, 8.0, 12.0})
	require.NotNil(t, hi)
	require.NotNil(t, ah)
	// avg of all 3 = (8+12+16)/3 = 12.0; hi = 12.0×0.96 = 11.52 → rounded to 11.5
	assert.Equal(t, 11.5, *hi)
	// ah = same avg 12.0 → 12.0
	assert.Equal(t, 12.0, *ah)
}

// TestComputeHandicapPair_EightRounds verifies that exactly 8 differentials
// uses all 8 for both ends (hi gets lowest 8, ah gets highest 8 — same set).
func TestComputeHandicapPair_EightRounds(t *testing.T) {
	diffs := []float64{10, 11, 12, 13, 14, 15, 16, 17}
	hi, ah := handlers.ComputeHandicapPairExported(diffs)
	require.NotNil(t, hi)
	require.NotNil(t, ah)
	// avg of all 8 = (10+11+…+17)/8 = 108/8 = 13.5; hi = 13.5×0.96 = 12.96 → 13.0
	assert.Equal(t, 13.0, *hi)
	// ah = same avg 13.5 → 13.5
	assert.Equal(t, 13.5, *ah)
}

// TestComputeHandicapPair_TwentyRounds verifies that with 20 differentials
// only the best (lowest) 8 are used for hi and worst (highest) 8 for ah.
func TestComputeHandicapPair_TwentyRounds(t *testing.T) {
	// 20 differentials: 1.0 through 20.0
	diffs := make([]float64, 20)
	for i := range diffs {
		diffs[i] = float64(i + 1)
	}
	hi, ah := handlers.ComputeHandicapPairExported(diffs)
	require.NotNil(t, hi)
	require.NotNil(t, ah)
	// best 8: avg(1+2+…+8)/8 = 36/8 = 4.5; hi = 4.5×0.96 = 4.32 → 4.3
	assert.Equal(t, 4.3, *hi)
	// worst 8: avg(13+14+…+20)/8 = 132/8 = 16.5; ah = 16.5
	assert.Equal(t, 16.5, *ah)
}
