// Package middleware_test covers the Auth middleware.
// All tests here are Tier 1 — no JWKS server, no database required.
// Only paths that return 401 before JWT parsing or DB access are covered here;
// those paths are reached regardless of whether the JWKS or DB are configured.
package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/middleware"
)

// makeAuthApp builds a minimal Fiber app using MakeAuthHandler with nil JWKS and
// nil DB. This is safe only for tests that exercise paths returning 401 before
// jwt.ParseWithClaims or any DB call is reached.
func makeAuthApp() *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Get("/test", middleware.MakeAuthHandler(nil, nil), func(c *fiber.Ctx) error {
		return c.SendStatus(fiber.StatusOK)
	})
	return app
}

// TestAuth_NoAuthorizationHeader_Unauthorized verifies that a request with no
// Authorization header is rejected with 401 before any JWT or DB work is done.
func TestAuth_NoAuthorizationHeader_Unauthorized(t *testing.T) {
	app := makeAuthApp()

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	resp, err := app.Test(req, -1)

	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// TestAuth_MissingBearerPrefix_Unauthorized verifies that an Authorization header
// that does not start with "Bearer " is rejected with 401.
func TestAuth_MissingBearerPrefix_Unauthorized(t *testing.T) {
	app := makeAuthApp()

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Authorization", "Basic abc123")
	resp, err := app.Test(req, -1)

	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
