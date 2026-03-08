// health_test.go
// Unit tests for the GET /health endpoint.
//
// Go test files always end in _test.go — the compiler excludes them from production builds.
// The package name "handlers_test" (note the _test suffix) is Go's "black-box" testing
// convention: it compiles as a separate package, so tests can only access exported
// symbols. This is intentional — if a test can't reach it, external callers can't either.
//
// Run all backend tests from the backend/ directory:
//
//	go test ./...
//
// Run just this file's tests:
//
//	go test ./internal/handlers/ -run TestHealth -v
//
// The -v flag prints each test name and its PASS/FAIL result.
package handlers_test

import (
	// "net/http" provides the HTTP status code constants (http.StatusOK, etc.)
	"net/http"
	// "testing" is Go's built-in test framework — every test function receives *testing.T
	"testing"

	// assert: checks a condition and records a failure, but lets the test keep running.
	// require: checks a condition and STOPS the test immediately on failure.
	// Use require for setup steps (if this fails, the rest of the test makes no sense).
	// Use assert for the actual assertions (run them all to see every failure at once).
	"github.com/stretchr/testify/assert"

	// Our handler under test
	"github.com/trentd187/golf-league/internal/handlers"
	// Shared test helpers (NewTestApp, DoRequest, MustReadBody)
	"github.com/trentd187/golf-league/internal/testutil"
)

// TestHealthCheck_ReturnsOK verifies that GET /health responds with 200 OK.
//
// Test function names in Go follow the pattern: Test<Subject>_<Scenario>.
// The testing framework discovers them automatically — any function named Test*
// that accepts *testing.T is a test.
func TestHealthCheck_ReturnsOK(t *testing.T) {
	// Arrange: build a minimal Fiber app with only the health route registered.
	// No database, no auth middleware — the health handler doesn't need either.
	app := testutil.NewTestApp(t, http.MethodGet, "/health", handlers.HealthCheck)

	// Act: fire a real HTTP request through Fiber's in-memory pipeline.
	resp := testutil.DoRequest(t, app, http.MethodGet, "/health", nil)

	// Assert: verify the status code.
	// assert.Equal(t, expected, actual, optionalMessage)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

// TestHealthCheck_ResponseBody verifies that the response body contains the expected JSON.
//
// This is a separate test from the status-code check so that each test has a single,
// clearly named responsibility. When a test fails, the name tells you exactly what broke.
func TestHealthCheck_ResponseBody(t *testing.T) {
	// Arrange
	app := testutil.NewTestApp(t, http.MethodGet, "/health", handlers.HealthCheck)

	// Act
	resp := testutil.DoRequest(t, app, http.MethodGet, "/health", nil)

	// Assert: read the body and check it contains the expected JSON field.
	// assert.Contains is a substring check — it doesn't require an exact match,
	// so the test stays valid even if Fiber adds whitespace or reorders fields.
	body := testutil.MustReadBody(t, resp)
	assert.Contains(t, body, `"status"`)
	assert.Contains(t, body, `"ok"`)
}
