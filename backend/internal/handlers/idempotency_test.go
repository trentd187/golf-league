// idempotency_test.go
// Tier 1 tests for GET /api/v1/idempotency/:key (create-side phantom recovery). The store
// is a fake idempotencyLooker, so every branch — replay hit, not-found, store error, and
// missing auth — runs without a real database.
//
// Run just this file:  go test ./internal/handlers/ -run TestLookupIdempotent -v
package handlers_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/handlers"
	"github.com/trentd187/golf-league/internal/middleware"
)

// fakeLooker returns whatever the test configures from Lookup, so all four handler
// branches run with no database.
type fakeLooker struct {
	rec   *middleware.IdempotencyRecord
	found bool
	err   error
}

func (f fakeLooker) Lookup(context.Context, string, uuid.UUID) (*middleware.IdempotencyRecord, bool, error) {
	return f.rec, f.found, f.err
}

// intp/strp are pointer helpers for the record's optional response fields.
func intp(i int) *int       { return &i }
func strp(s string) *string { return &s }

// lookupApp mounts the handler behind a middleware that seeds userID (as middleware.Auth
// would). Pass userID="" to simulate a missing/invalid auth context.
func lookupApp(store handlersLooker, userID string) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Get("/idempotency/:key", func(c *fiber.Ctx) error {
		if userID != "" {
			c.Locals("userID", userID)
		}
		return c.Next()
	}, handlers.LookupIdempotentResponse(store))
	return app
}

// handlersLooker mirrors the handler's unexported interface so the fake satisfies it.
type handlersLooker interface {
	Lookup(ctx context.Context, key string, userID uuid.UUID) (*middleware.IdempotencyRecord, bool, error)
}

func doGet(t *testing.T, app *fiber.App, path string) *http.Response {
	t.Helper()
	resp, err := app.Test(httptest.NewRequest(http.MethodGet, path, nil), -1)
	require.NoError(t, err)
	return resp
}

func TestLookupIdempotent_Hit_ReplaysStoredResponse(t *testing.T) {
	uid := uuid.New()
	store := fakeLooker{
		rec:   &middleware.IdempotencyRecord{UserID: uid, ResponseStatus: intp(http.StatusCreated), ResponseBody: strp(`{"id":"r1"}`)},
		found: true,
	}
	resp := doGet(t, lookupApp(store, uid.String()), "/idempotency/key-123")
	assert.Equal(t, http.StatusCreated, resp.StatusCode)
	assert.Equal(t, "true", resp.Header.Get("Idempotent-Replay"))

	defer resp.Body.Close()
	buf := make([]byte, 64)
	n, _ := resp.Body.Read(buf)
	assert.Contains(t, string(buf[:n]), `"id":"r1"`)
}

func TestLookupIdempotent_NotFound_Returns404(t *testing.T) {
	resp := doGet(t, lookupApp(fakeLooker{found: false}, uuid.NewString()), "/idempotency/absent")
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestLookupIdempotent_StoreError_Returns500(t *testing.T) {
	store := fakeLooker{err: errors.New("db down")}
	resp := doGet(t, lookupApp(store, uuid.NewString()), "/idempotency/key-123")
	assert.Equal(t, http.StatusInternalServerError, resp.StatusCode)
}

func TestLookupIdempotent_MissingAuth_Returns401(t *testing.T) {
	resp := doGet(t, lookupApp(fakeLooker{found: true}, ""), "/idempotency/key-123")
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
