// Package middleware_test covers the CORS allow-list. Tier 1 — a preflight OPTIONS against
// a Fiber app wired with middleware.CORS() asserts the browser will be allowed to send the
// Idempotency-Key (web phantom-write dedupe) and the Sentry tracing headers. Guards against
// a config change that would silently strip them on the web build.
package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/trentd187/golf-league/internal/middleware"
)

// preflight sends a CORS preflight OPTIONS asking to use the given request headers and
// returns the Access-Control-Allow-Headers the middleware responds with.
func preflight(t *testing.T, requestHeaders string) string {
	t.Helper()
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(middleware.CORS())
	app.Put("/api/v1/rounds/r1/players/p1/scores", func(c *fiber.Ctx) error {
		return c.SendStatus(fiber.StatusOK)
	})

	req := httptest.NewRequest(http.MethodOptions, "/api/v1/rounds/r1/players/p1/scores", nil)
	req.Header.Set("Origin", "https://golf-web-production.up.railway.app")
	req.Header.Set("Access-Control-Request-Method", http.MethodPut)
	req.Header.Set("Access-Control-Request-Headers", requestHeaders)

	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	return resp.Header.Get("Access-Control-Allow-Headers")
}

func TestCORS_AllowsIdempotencyKeyOnPreflight(t *testing.T) {
	allowed := preflight(t, "Idempotency-Key")
	assert.Contains(t, strings.ToLower(allowed), "idempotency-key",
		"web preflight must allow Idempotency-Key or retries lose the phantom-write dedupe")
}

func TestCORS_AllowsAuthAndTracingHeaders(t *testing.T) {
	allowed := strings.ToLower(preflight(t, "Authorization,sentry-trace,baggage"))
	assert.Contains(t, allowed, "authorization")
	assert.Contains(t, allowed, "sentry-trace")
	assert.Contains(t, allowed, "baggage")
}
