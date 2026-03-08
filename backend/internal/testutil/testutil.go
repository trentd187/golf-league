// Package testutil provides shared helpers used across all _test.go files in the backend.
//
// What lives here:
//   - NewTestApp:   creates a bare Fiber app with a single route — no auth, no DB.
//     Used for unit-testing individual handlers in isolation.
//   - DoRequest:    fires an in-memory HTTP request through a test app.
//   - MustReadBody: reads a response body into a string for assertions.
//
// Future addition (when score/handicap handlers are built):
//   - NewTestDB: connects to a test PostgreSQL instance (TEST_DATABASE_URL), runs migrations,
//     and returns a *gorm.DB. Each test that needs a real DB calls this and defers cleanup.
package testutil

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	// require stops the test immediately on failure; assert lets the test continue.
	"github.com/stretchr/testify/require"
)

// NewTestApp creates a minimal Fiber application for handler unit tests.
// The returned app has no auth middleware and no database — just the single route.
//
// Usage:
//
//	app := testutil.NewTestApp(t, "GET", "/health", handlers.HealthCheck)
//	resp := testutil.DoRequest(t, app, http.MethodGet, "/health", nil)
func NewTestApp(t *testing.T, method, path string, handler fiber.Handler) *fiber.App {
	t.Helper() // marks this as a helper so failure lines point to the caller

	app := fiber.New(fiber.Config{
		DisableStartupMessage: true, // suppress banner in test output
	})

	// app.Add is the generic form of app.Get/app.Post — accepts any HTTP method string.
	app.Add(method, path, handler)

	return app
}

// DoRequest fires an HTTP request against a Fiber test app and returns the response.
// body may be nil for requests without a body (e.g. GET).
// The test fails immediately if Fiber returns an error running the request.
func DoRequest(t *testing.T, app *fiber.App, method, path string, body []byte) *http.Response {
	t.Helper()

	// httptest.NewRequest builds a request without a real network connection.
	// bytes.NewReader(nil) produces an empty reader — safe for GET requests.
	req := httptest.NewRequest(method, path, bytes.NewReader(body))

	// -1 disables the default 1-second timeout, letting slow tests finish naturally.
	resp, err := app.Test(req, -1)
	require.NoError(t, err, "Fiber test request failed")

	return resp
}

// MustReadBody reads the entire response body and returns it as a string.
// Closes the body after reading — callers should not read it again.
func MustReadBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	require.NoError(t, err, "failed to read response body")

	return string(data)
}
