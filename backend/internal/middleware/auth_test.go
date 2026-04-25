// Package middleware_test covers the Auth middleware.
// All tests here are Tier 1 — no JWKS server, no database required.
// Paths that return 401 before JWT parsing use a nil keyfunc; paths that reach
// jwt.ParseWithClaims use an errKeyfunc that always returns an error.
package middleware_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/middleware"
)

// errKeyfunc is a jwt.Keyfunc that always returns an error, simulating a token
// whose key ID is not in the JWKS (e.g. forged or expired key rotation).
func errKeyfunc(_ *jwt.Token) (interface{}, error) {
	return nil, errors.New("mock: key not found")
}

// makeAuthApp builds a minimal Fiber app using MakeAuthHandler with a nil keyfunc
// and nil DB. Safe only for tests that exercise paths returning 401 before
// jwt.ParseWithClaims is reached.
func makeAuthApp() *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Get("/test", middleware.MakeAuthHandler(nil, nil), func(c *fiber.Ctx) error {
		return c.SendStatus(fiber.StatusOK)
	})
	return app
}

// makeAuthAppWithKeyfunc builds a Fiber app that reaches jwt.ParseWithClaims.
// keyfn controls what the parser does with a syntactically valid token.
func makeAuthAppWithKeyfunc(keyfn jwt.Keyfunc) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Get("/test", middleware.MakeAuthHandler(keyfn, nil), func(c *fiber.Ctx) error {
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

// TestAuth_InvalidToken_Unauthorized verifies that a syntactically valid Bearer
// token rejected by the keyfunc (e.g. unknown key ID) returns 401.
// The token string is a real HS256 JWT signed with a different key so that
// jwt.ParseWithClaims reaches the keyfunc before failing.
func TestAuth_InvalidToken_Unauthorized(t *testing.T) {
	app := makeAuthAppWithKeyfunc(errKeyfunc)

	// A real HS256 JWT with payload {"sub":"test"} signed with key "wrong-secret".
	// Syntactically valid so ParseWithClaims attempts key lookup via the keyfunc.
	const fakeToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
		"eyJzdWIiOiJ0ZXN0In0." +
		"WaFfXO4UBFWxG1xNLUSOCxqJjJQ6kJXBF1PF1_FAKE"

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Authorization", "Bearer "+fakeToken)
	resp, err := app.Test(req, -1)

	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
