// Package middleware contains HTTP middleware functions for the Golf League API.
// This file handles role-based access control (RBAC).
// The two global roles are: admin, user.
package middleware

// roles.go — Role-based access control middleware.

import "github.com/gofiber/fiber/v2"

// RequireRole returns a middleware handler that allows only users whose role
// matches one of the provided roles. Returns HTTP 403 Forbidden otherwise.
//
// Accepts a variadic list of roles so you can allow multiple on one route:
//
//	app.Post("/courses", middleware.RequireRole("admin"), handlers.CreateCourse)
//
// Must be used AFTER the Auth middleware, which populates "userRole" in c.Locals.
func RequireRole(roles ...string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// .(string) is a type assertion — converts the interface{} value to a concrete string.
		// If the value is missing or isn't a string, ok will be false.
		userRole, ok := c.Locals("userRole").(string)
		if !ok || userRole == "" {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error": "forbidden",
			})
		}

		for _, role := range roles {
			if userRole == role {
				return c.Next()
			}
		}

		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
			"error": "insufficient permissions",
		})
	}
}
