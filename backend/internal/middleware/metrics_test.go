// Package middleware_test covers the HTTPMetrics middleware.
// All tests are Tier 1 — no OTel SDK, database, or network required.
// A zero-value observability.Metrics struct is used; RecordHTTP returns early
// when instruments are nil, so no OTel pipeline needs to be running.
package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/middleware"
	"github.com/trentd187/golf-league/internal/observability"
)

// makeMetricsApp builds a Fiber app with HTTPMetrics using a zero-value Metrics struct
// and an optional downstream handler. handlerStatus 0 means no route is registered
// (so Fiber returns its default 404 for unmatched paths).
func makeMetricsApp(handlerStatus int) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(middleware.HTTPMetrics(&observability.Metrics{}))
	if handlerStatus != 0 {
		app.Get("/test", func(c *fiber.Ctx) error {
			return c.SendStatus(handlerStatus)
		})
	}
	return app
}

// TestHTTPMetrics_PassesThrough_200 verifies the middleware calls Next() and the
// downstream handler's 200 status is returned unchanged.
func TestHTTPMetrics_PassesThrough_200(t *testing.T) {
	app := makeMetricsApp(http.StatusOK)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	resp, err := app.Test(req, -1)

	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

// TestHTTPMetrics_PassesThrough_404 verifies that Fiber's default 404 for an
// unmatched route flows through the middleware unchanged.
func TestHTTPMetrics_PassesThrough_404(t *testing.T) {
	app := makeMetricsApp(0) // no route registered

	req := httptest.NewRequest(http.MethodGet, "/nonexistent", nil)
	resp, err := app.Test(req, -1)

	require.NoError(t, err)
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

// TestHTTPMetrics_DoesNotPanicWithNilInstruments verifies that passing a zero-value
// Metrics struct (all instruments nil) does not panic. RecordHTTP guards on nil
// HTTPRequestsTotal and returns early — this test confirms that guard works end-to-end.
func TestHTTPMetrics_DoesNotPanicWithNilInstruments(t *testing.T) {
	app := makeMetricsApp(http.StatusOK)
	req := httptest.NewRequest(http.MethodGet, "/test", nil)

	assert.NotPanics(t, func() {
		_, err := app.Test(req, -1)
		require.NoError(t, err)
	})
}

// TestHTTPMetrics_500_LogsError verifies that a 5xx response triggers the http.error
// log path without panicking (no error_detail set — exercises the false branch of the
// detail check).
func TestHTTPMetrics_500_LogsError(t *testing.T) {
	app := makeMetricsApp(http.StatusInternalServerError)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	resp, err := app.Test(req, -1)

	require.NoError(t, err)
	assert.Equal(t, http.StatusInternalServerError, resp.StatusCode)
}

// TestHTTPMetrics_500_WithErrorDetail verifies that when c.Locals("error_detail") is
// non-empty, the middleware appends it to the http.error log args without panicking.
// This exercises the true branch of the detail check added to the 5xx log path.
func TestHTTPMetrics_500_WithErrorDetail(t *testing.T) {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(middleware.HTTPMetrics(&observability.Metrics{}))
	app.Get("/test", func(c *fiber.Ctx) error {
		c.Locals("error_detail", "auth.db_error: connection refused")
		return c.SendStatus(http.StatusInternalServerError)
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	resp, err := app.Test(req, -1)

	require.NoError(t, err)
	assert.Equal(t, http.StatusInternalServerError, resp.StatusCode)
}
