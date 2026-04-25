// users_test.go
// Unit tests for the /api/v1/me and /api/v1/users handlers.
//
// Strategy: Tier 1 only — tests exercise validation paths that return before
// any DB call, so nil can be safely passed as *gorm.DB.
//
// GetMe Tier 1 paths:
//   - No userID local (missing auth middleware) → 401
//
// GetUsers Tier 1 paths:
//   - None: the handler calls db.Where(...).Find(...) before any validation,
//     so testing the avatar_url field in the response requires a real DB (Tier 2).
//
// Run:
//
//	go test ./internal/handlers/ -run TestGetMe -v
//	go test ./internal/handlers/ -run TestGetUsers -v
package handlers_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/handlers"
)

// TestGetMe_NoAuth_Unauthorized verifies that GET /api/v1/me returns 401 when no
// userID has been injected into the request context (i.e. no auth middleware ran).
// This exercises the `!ok || callerIDStr == ""` guard at the top of GetMe.
func TestGetMe_NoAuth_Unauthorized(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/api/v1/me", handlers.GetMe(nil))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/v1/me", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// TestGetUsers_ReturnsOK_WithoutAuth verifies that GET /api/v1/users returns 200
// when called with a valid userID local but a nil DB — confirming the handler
// does not validate the caller's ID before querying. This path would panic with
// a nil DB in production; the test serves as documentation that GetUsers has no
// Tier 1 early-exit paths and its full response shape (including avatar_url) can
// only be verified with a real database in Tier 2 tests.
//
// Skipped: GetUsers calls db.Where().Find() immediately, so nil DB panics.
// This comment block stands in for a Tier 2 test that is not yet implemented.
func TestGetUsers_AvatarURL_RequiresTier2(t *testing.T) {
	t.Skip("GetUsers hits the DB before any validation — avatar_url field correctness requires Tier 2 (real DB)")
}
