// Package middleware_test covers the DURABLE Idempotency-Key store + middleware that
// make non-idempotent POST creates safe to retry. Tier 2 — backed by a real Postgres
// (testutil.NewTestDB) because the whole point of the durable store is that key state
// lives in the DB, not memory. Tests must NOT call t.Parallel() (NewTestDB TRUNCATEs
// globally). The in-memory detection-only store is covered in idempotency_test.go.
package middleware_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/middleware"
	"github.com/trentd187/golf-league/internal/testutil"
)

// ─── Store unit behaviour (over a real DB) ──────────────────────────────────────

func TestDurableStore_FirstClaimIsOwned(t *testing.T) {
	store := middleware.NewDurableIdempotencyStore(testutil.NewTestDB(t))
	rec, claimed, err := store.Claim(context.Background(), "k1", uuid.New(), "POST", "/things", "h1")
	require.NoError(t, err)
	assert.True(t, claimed, "first sighting of a key is owned by this caller")
	assert.Nil(t, rec)
}

func TestDurableStore_ClaimThenStoreReplays(t *testing.T) {
	store := middleware.NewDurableIdempotencyStore(testutil.NewTestDB(t))
	ctx := context.Background()
	uid := uuid.New()

	_, claimed, err := store.Claim(ctx, "k1", uid, "POST", "/things", "h1")
	require.NoError(t, err)
	require.True(t, claimed)
	require.NoError(t, store.Store(ctx, "k1", http.StatusCreated, `{"id":"abc"}`))

	rec, claimed, err := store.Claim(ctx, "k1", uid, "POST", "/things", "h1")
	require.NoError(t, err)
	assert.False(t, claimed, "a repeated key is not re-owned")
	require.NotNil(t, rec)
	require.NotNil(t, rec.ResponseStatus)
	assert.Equal(t, http.StatusCreated, *rec.ResponseStatus)
	require.NotNil(t, rec.ResponseBody)
	assert.Equal(t, `{"id":"abc"}`, *rec.ResponseBody)
}

func TestDurableStore_InFlightHasNilStatus(t *testing.T) {
	store := middleware.NewDurableIdempotencyStore(testutil.NewTestDB(t))
	ctx := context.Background()
	uid := uuid.New()

	_, claimed, err := store.Claim(ctx, "k1", uid, "POST", "/things", "h1")
	require.NoError(t, err)
	require.True(t, claimed)

	// No Store yet → the original is still in flight.
	rec, claimed, err := store.Claim(ctx, "k1", uid, "POST", "/things", "h1")
	require.NoError(t, err)
	assert.False(t, claimed)
	require.NotNil(t, rec)
	assert.Nil(t, rec.ResponseStatus, "an unfinished original has no stored status")
}

func TestDurableStore_ReleaseAllowsReclaim(t *testing.T) {
	store := middleware.NewDurableIdempotencyStore(testutil.NewTestDB(t))
	ctx := context.Background()
	uid := uuid.New()

	_, claimed, err := store.Claim(ctx, "k1", uid, "POST", "/things", "h1")
	require.NoError(t, err)
	require.True(t, claimed)
	require.NoError(t, store.Release(ctx, "k1"))

	_, claimed, err = store.Claim(ctx, "k1", uid, "POST", "/things", "h1")
	require.NoError(t, err)
	assert.True(t, claimed, "a released key is free to be claimed again")
}

func TestDurableStore_ExpiredKeyIsReclaimable(t *testing.T) {
	store := middleware.NewDurableIdempotencyStore(testutil.NewTestDB(t))
	clock := time.Unix(1_700_000_000, 0)
	store.SetDurableClockForTest(func() time.Time { return clock })
	ctx := context.Background()
	uid := uuid.New()

	_, claimed, err := store.Claim(ctx, "k1", uid, "POST", "/things", "h1")
	require.NoError(t, err)
	require.True(t, claimed)
	require.NoError(t, store.Store(ctx, "k1", http.StatusCreated, `{"id":"old"}`))

	// Advance past the 24h TTL: the stale row must be reclaimable, not a forever replay.
	clock = clock.Add(25 * time.Hour)
	rec, claimed, err := store.Claim(ctx, "k1", uid, "POST", "/things", "h1")
	require.NoError(t, err)
	assert.True(t, claimed, "an expired key is reclaimed for a fresh request")
	assert.Nil(t, rec)
}

func TestDurableStore_HashMismatchIsVisible(t *testing.T) {
	store := middleware.NewDurableIdempotencyStore(testutil.NewTestDB(t))
	ctx := context.Background()
	uid := uuid.New()

	_, _, err := store.Claim(ctx, "k1", uid, "POST", "/things", "hashA")
	require.NoError(t, err)
	require.NoError(t, store.Store(ctx, "k1", http.StatusCreated, `{}`))

	rec, claimed, err := store.Claim(ctx, "k1", uid, "POST", "/things", "hashB")
	require.NoError(t, err)
	assert.False(t, claimed)
	require.NotNil(t, rec)
	assert.Equal(t, "hashA", rec.RequestHash, "the original hash is exposed so the middleware can reject a reused key")
}

// ─── Middleware end-to-end ──────────────────────────────────────────────────────

// newCreateApp wires the Idempotency middleware ahead of a create handler that returns
// 201 with an incrementing id, so a replay (same body echoed) is distinguishable from a
// fresh create (a new id). userID is injected the way middleware.Auth would; an
// X-Test-User header overrides it for the cross-user case.
func newCreateApp(store *middleware.DurableIdempotencyStore, userID uuid.UUID, created *int) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(func(c *fiber.Ctx) error {
		uid := userID.String()
		if h := c.Get("X-Test-User"); h != "" {
			uid = h
		}
		c.Locals("userID", uid)
		return c.Next()
	})
	app.Post("/things", middleware.Idempotency(store), func(c *fiber.Ctx) error {
		*created++
		return c.Status(fiber.StatusCreated).JSON(fiber.Map{"id": *created})
	})
	return app
}

// doPost fires a POST with an optional Idempotency-Key and X-Test-User override.
func doPost(t *testing.T, app *fiber.App, key, body, asUser string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/things", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	if asUser != "" {
		req.Header.Set("X-Test-User", asUser)
	}
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	return resp
}

func bodyString(t *testing.T, resp *http.Response) string {
	t.Helper()
	return testutil.MustReadBody(t, resp)
}

func TestIdempotencyMiddleware_RetryReplaysAndDoesNotDoubleCreate(t *testing.T) {
	store := middleware.NewDurableIdempotencyStore(testutil.NewTestDB(t))
	created := 0
	app := newCreateApp(store, uuid.New(), &created)

	first := doPost(t, app, "key-1", `{"name":"Wed Round"}`, "")
	assert.Equal(t, http.StatusCreated, first.StatusCode)
	firstBody := bodyString(t, first)

	second := doPost(t, app, "key-1", `{"name":"Wed Round"}`, "")
	assert.Equal(t, http.StatusCreated, second.StatusCode)
	assert.Equal(t, firstBody, bodyString(t, second), "retry replays the original response verbatim")
	assert.Equal(t, "true", second.Header.Get("Idempotent-Replay"))
	assert.Equal(t, 1, created, "the handler ran exactly once — no duplicate row")
}

func TestIdempotencyMiddleware_DistinctKeysEachCreate(t *testing.T) {
	store := middleware.NewDurableIdempotencyStore(testutil.NewTestDB(t))
	created := 0
	app := newCreateApp(store, uuid.New(), &created)

	doPost(t, app, "key-1", `{"name":"a"}`, "")
	doPost(t, app, "key-2", `{"name":"b"}`, "")
	assert.Equal(t, 2, created, "different keys are independent creates")
}

func TestIdempotencyMiddleware_NoKeyIsNotDeduped(t *testing.T) {
	store := middleware.NewDurableIdempotencyStore(testutil.NewTestDB(t))
	created := 0
	app := newCreateApp(store, uuid.New(), &created)

	doPost(t, app, "", `{"name":"a"}`, "")
	doPost(t, app, "", `{"name":"a"}`, "")
	assert.Equal(t, 2, created, "keyless requests pass through undeduped (back-compat)")
}

func TestIdempotencyMiddleware_InFlightReturns409(t *testing.T) {
	store := middleware.NewDurableIdempotencyStore(testutil.NewTestDB(t))
	created := 0
	uid := uuid.New()
	app := newCreateApp(store, uid, &created)

	// Pre-claim the key WITHOUT storing a response — simulates the original still
	// running. Use the exact fingerprint the middleware will compute so the retry takes
	// the in-flight branch (not the hash-mismatch branch, which is checked first).
	body := `{"name":"a"}`
	hash := middleware.RequestFingerprint(http.MethodPost, "/things", []byte(body))
	_, claimed, err := store.Claim(context.Background(), "key-1", uid, http.MethodPost, "/things", hash)
	require.NoError(t, err)
	require.True(t, claimed)

	resp := doPost(t, app, "key-1", body, "")
	assert.Equal(t, http.StatusConflict, resp.StatusCode, "an overlapping retry is told to back off")
	assert.Equal(t, 0, created, "the handler does not run while the original is in flight")
}

func TestIdempotencyMiddleware_HashMismatchReturns422(t *testing.T) {
	store := middleware.NewDurableIdempotencyStore(testutil.NewTestDB(t))
	created := 0
	app := newCreateApp(store, uuid.New(), &created)

	doPost(t, app, "key-1", `{"name":"a"}`, "")
	resp := doPost(t, app, "key-1", `{"name":"DIFFERENT"}`, "")
	assert.Equal(t, http.StatusUnprocessableEntity, resp.StatusCode, "a key reused with a different body is rejected")
	assert.Equal(t, 1, created, "the mismatched retry never reaches the handler")
}

func TestIdempotencyMiddleware_DifferentUserReturns409(t *testing.T) {
	store := middleware.NewDurableIdempotencyStore(testutil.NewTestDB(t))
	created := 0
	app := newCreateApp(store, uuid.New(), &created)

	doPost(t, app, "key-1", `{"name":"a"}`, "")
	resp := doPost(t, app, "key-1", `{"name":"a"}`, uuid.New().String())
	assert.Equal(t, http.StatusConflict, resp.StatusCode, "a key belonging to another caller is refused")
	assert.Equal(t, 1, created)
}

func TestIdempotencyMiddleware_NonSuccessIsReleasedForFreshRetry(t *testing.T) {
	store := middleware.NewDurableIdempotencyStore(testutil.NewTestDB(t))
	attempts := 0
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	uid := uuid.New()
	app.Use(func(c *fiber.Ctx) error { c.Locals("userID", uid.String()); return c.Next() })
	app.Post("/things", middleware.Idempotency(store), func(c *fiber.Ctx) error {
		attempts++
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "nope"})
	})

	first := doPost(t, app, "key-1", `{"x":1}`, "")
	assert.Equal(t, http.StatusBadRequest, first.StatusCode)
	second := doPost(t, app, "key-1", `{"x":1}`, "")
	assert.Equal(t, http.StatusBadRequest, second.StatusCode)
	assert.Equal(t, 2, attempts, "a failed create is not cached — the retry runs fresh")
}

func TestIdempotencyMiddleware_InvalidAuthPassesThrough(t *testing.T) {
	// No userID local set and a key present → the middleware can't scope the key, so it
	// defers to the route's own auth handling rather than claiming. No DB needed.
	store := middleware.NewDurableIdempotencyStore(nil)
	created := 0
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Post("/things", middleware.Idempotency(store), func(c *fiber.Ctx) error {
		created++
		return c.SendStatus(fiber.StatusCreated)
	})
	resp := doPost(t, app, "key-1", `{}`, "")
	assert.Equal(t, http.StatusCreated, resp.StatusCode)
	assert.Equal(t, 1, created)
}

// jsonField pulls a top-level field from a JSON response body (handy for asserting the
// replayed id matches). Unused fields are ignored.
func jsonField(t *testing.T, body, field string) any {
	t.Helper()
	var m map[string]any
	require.NoError(t, json.Unmarshal([]byte(body), &m))
	return m[field]
}

func TestIdempotencyMiddleware_ReplayPreservesId(t *testing.T) {
	store := middleware.NewDurableIdempotencyStore(testutil.NewTestDB(t))
	created := 0
	app := newCreateApp(store, uuid.New(), &created)

	first := bodyString(t, doPost(t, app, "key-1", `{}`, ""))
	second := bodyString(t, doPost(t, app, "key-1", `{}`, ""))
	assert.Equal(t, jsonField(t, first, "id"), jsonField(t, second, "id"),
		"the replay returns the same new-row id the client needs to navigate")
}
