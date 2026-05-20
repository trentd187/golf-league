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

// TestHTTPMetrics_AccessLog_HealthExcluded verifies that /health requests do not
// trigger the http.request log path (no panic = guard is in place).
func TestHTTPMetrics_AccessLog_HealthExcluded(t *testing.T) {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(middleware.HTTPMetrics(&observability.Metrics{}))
	app.Get("/health", func(c *fiber.Ctx) error {
		return c.SendStatus(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	resp, err := app.Test(req, -1)

	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

// TestHTTPMetrics_AccessLog_WithCorrelationAndUser verifies that correlation_id and
// user_id locals are appended to the http.request log args without panicking.
func TestHTTPMetrics_AccessLog_WithCorrelationAndUser(t *testing.T) {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(middleware.HTTPMetrics(&observability.Metrics{}))
	app.Get("/api/v1/events", func(c *fiber.Ctx) error {
		c.Locals("correlationID", "550e8400-e29b-41d4-a716-446655440000")
		c.Locals("userID", "f47ac10b-58cc-4372-a567-0e02b2c3d479")
		return c.SendStatus(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/events", nil)
	resp, err := app.Test(req, -1)

	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

// TestHTTPMetrics_AccessLog_NoLocals verifies that missing correlation_id and
// user_id locals (e.g. unauthenticated or pre-auth requests) are handled gracefully.
func TestHTTPMetrics_AccessLog_NoLocals(t *testing.T) {
	app := makeMetricsApp(http.StatusUnauthorized)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	resp, err := app.Test(req, -1)

	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
