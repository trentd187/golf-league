// health_test.go
// Unit tests for the GET /health endpoint.
//
// Go test files end in _test.go — excluded from production builds automatically.
// The package name "handlers_test" (black-box style) compiles as a separate package
// so tests can only access exported symbols.
//
// Run all backend tests:    go test ./...
// Run just this file:       go test ./internal/handlers/ -run TestHealth -v
package handlers_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/trentd187/golf-league/internal/handlers"
	"github.com/trentd187/golf-league/internal/testutil"
)

// TestHealthCheck_ReturnsOK verifies that GET /health responds with 200 OK.
// Test function names follow the pattern: Test<Subject>_<Scenario>.
func TestHealthCheck_ReturnsOK(t *testing.T) {
	app := testutil.NewTestApp(t, http.MethodGet, "/health", handlers.HealthCheck)
	resp := testutil.DoRequest(t, app, http.MethodGet, "/health", nil)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

// TestHealthCheck_ResponseBody verifies that the response body contains the expected JSON.
// Kept as a separate test so each has a single, clearly named responsibility.
func TestHealthCheck_ResponseBody(t *testing.T) {
	app := testutil.NewTestApp(t, http.MethodGet, "/health", handlers.HealthCheck)
	resp := testutil.DoRequest(t, app, http.MethodGet, "/health", nil)

	// assert.Contains is a substring check — stays valid even if Fiber adds whitespace.
	body := testutil.MustReadBody(t, resp)
	assert.Contains(t, body, `"status"`)
	assert.Contains(t, body, `"ok"`)
}
