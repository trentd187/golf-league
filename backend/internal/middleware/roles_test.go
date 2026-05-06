// Package middleware_test covers the RBAC role-checking middleware.
// All tests are Tier 1 — no database or network required.
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

// makeRoleApp builds a minimal Fiber app that sets userRole in Locals (if non-empty),
// runs RequireRole, then returns 200 if the middleware calls Next().
func makeRoleApp(localRole string, allowedRoles ...string) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Get("/test", func(c *fiber.Ctx) error {
		if localRole != "" {
			c.Locals("userRole", localRole)
		}
		return c.Next()
	}, middleware.RequireRole(allowedRoles...), func(c *fiber.Ctx) error {
		return c.SendStatus(fiber.StatusOK)
	})
	return app
}

func TestRequireRole_MissingLocal_Forbidden(t *testing.T) {
	app := makeRoleApp("" /* no local set */, "admin")

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	resp, err := app.Test(req, -1)

	require.NoError(t, err)
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestRequireRole_WrongRole_Forbidden(t *testing.T) {
	// user role is forbidden on an admin-only route (e.g. course mutations)
	app := makeRoleApp("user", "admin")

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	resp, err := app.Test(req, -1)

	require.NoError(t, err)
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestRequireRole_MatchingRole_Passes(t *testing.T) {
	// user role passes when it is explicitly included in the allowed set
	app := makeRoleApp("user", "admin", "user")

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	resp, err := app.Test(req, -1)

	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

func TestRequireRole_AdminRole_Passes(t *testing.T) {
	app := makeRoleApp("admin", "admin")

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	resp, err := app.Test(req, -1)

	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}
