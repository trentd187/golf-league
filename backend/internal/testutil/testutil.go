// Package testutil provides shared helpers used across all _test.go files in the backend.
//
// Go's testing package is built into the language — you run tests with `go test ./...`
// from the backend/ directory. This package collects the repetitive setup code that
// every test file would otherwise have to duplicate.
//
// What lives here:
//   - NewTestApp:    creates a bare Fiber app with a route registered — no auth middleware,
//     no DB required. Used for unit-testing individual handlers in isolation.
//   - MustReadBody: reads an HTTP response body into a string for assertions.
//
// What will live here later (as score/handicap handlers get built):
//   - NewTestDB:     spins up a connection to a test PostgreSQL database (controlled by the
//     TEST_DATABASE_URL environment variable) and runs migrations. Each test
//     that needs a real DB calls this and defers db.Close().
package testutil

import (
	// "bytes" builds an io.Reader from a byte slice — used for request bodies
	"bytes"
	// "io" provides io.ReadAll to drain a response body into a []byte
	"io"
	// "net/http" gives us the HTTP method constants (http.MethodGet, http.MethodPost, etc.)
	// and httptest.NewRequest for building in-memory requests
	"net/http"
	"net/http/httptest"

	// "testing" is Go's built-in test framework — t *testing.T is the test context
	"testing"

	// fiber is our HTTP framework — its app.Test() method runs an in-memory request
	// without needing a real network socket
	"github.com/gofiber/fiber/v2"
	// require stops the test immediately on failure (vs assert which continues)
	"github.com/stretchr/testify/require"
)

// NewTestApp creates a minimal Fiber application suitable for handler unit tests.
//
// Usage:
//
//	app := testutil.NewTestApp(t, "GET", "/health", handlers.HealthCheck)
//	resp := testutil.DoRequest(t, app, http.MethodGet, "/health", nil)
//	assert.Equal(t, http.StatusOK, resp.StatusCode)
//
// The returned app has no auth middleware and no database — it only has the single
// route you register here. This keeps tests fast and self-contained.
func NewTestApp(t *testing.T, method, path string, handler fiber.Handler) *fiber.App {
	t.Helper() // marks this as a helper so test failure lines point to the caller, not here

	// fiber.New() creates an isolated Fiber instance — each test gets its own,
	// so routes registered in one test don't bleed into another.
	app := fiber.New(fiber.Config{
		// Disable the startup banner in test output — it would clutter the test logs
		DisableStartupMessage: true,
	})

	// Register the single handler we're testing.
	// app.Add is the generic form of app.Get / app.Post / etc. — it accepts
	// any HTTP method string, which is useful in a generic helper like this.
	app.Add(method, path, handler)

	return app
}

// DoRequest fires an HTTP request against a Fiber test app and returns the response.
//
// Parameters:
//   - app:    the Fiber app created by NewTestApp
//   - method: HTTP method string, e.g. http.MethodGet, http.MethodPost
//   - path:   the URL path to request, e.g. "/health"
//   - body:   the request body as bytes (nil for requests without a body)
//
// The test fails immediately (require) if Fiber returns an error running the request.
func DoRequest(t *testing.T, app *fiber.App, method, path string, body []byte) *http.Response {
	t.Helper()

	// httptest.NewRequest builds an *http.Request without a real network connection.
	// bytes.NewReader(body) converts []byte → io.Reader, which the request expects.
	// If body is nil, bytes.NewReader(nil) produces an empty reader — safe for GET requests.
	req := httptest.NewRequest(method, path, bytes.NewReader(body))

	// app.Test() sends the request through Fiber's routing and middleware pipeline
	// and returns a *http.Response — exactly what you'd get from a real HTTP client.
	// -1 disables the default 1-second timeout, letting slow tests finish naturally.
	resp, err := app.Test(req, -1)
	require.NoError(t, err, "Fiber test request failed")

	return resp
}

// MustReadBody reads the entire response body and returns it as a string.
// Closes the body after reading — callers should not read it again.
//
// This is useful for asserting on the raw JSON response string, e.g.:
//
//	body := testutil.MustReadBody(t, resp)
//	assert.Contains(t, body, `"status":"ok"`)
func MustReadBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer resp.Body.Close()

	// io.ReadAll reads until EOF and returns the full content as []byte.
	data, err := io.ReadAll(resp.Body)
	require.NoError(t, err, "failed to read response body")

	return string(data)
}
