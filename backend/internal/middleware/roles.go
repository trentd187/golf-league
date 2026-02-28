// Package middleware contains HTTP middleware functions for the Golf League API.
// This file handles role-based access control (RBAC) — checking that the
// authenticated user has permission to perform the requested action.
package middleware

// roles.go — Role-based access control middleware.
// The app has three roles: admin, manager, user.
// These middleware functions are applied to routes that require specific permissions.

import "github.com/gofiber/fiber/v2"

// RequireRole returns a middleware handler that allows only users whose role
// matches one of the provided roles. Returns HTTP 403 Forbidden if the role
// doesn't match.
//
// It accepts a variadic list of roles ("..." syntax) so you can allow one or
// more roles on a route with a single call:
//
//   app.Post("/leagues", middleware.RequireRole("admin", "manager"), handlers.CreateLeague)
//
// RequireRole must be used AFTER the Auth middleware, because Auth is what
// populates the "userRole" value in the request context via c.Locals.
func RequireRole(roles ...string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// c.Locals("userRole") retrieves the role string that the Auth middleware
		// stored earlier in this request's context. The .(string) is a type assertion
		// to convert the interface{} value to a concrete string.
		// If the value is missing or isn't a string, ok will be false.
		userRole, ok := c.Locals("userRole").(string)
		if !ok || userRole == "" {
			// If we couldn't read a role, the Auth middleware either wasn't applied
			// or failed silently — deny access with 403 Forbidden (not 401, because
			// the user might be authenticated but still not have a role set)
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error": "forbidden",
			})
		}

		// Check if the user's role is in the allowed list.
		// Iterate through each role we accept for this route and return c.Next()
		// the moment we find a match — allowing the request to continue.
		for _, role := range roles {
			if userRole == role {
				// Role is allowed — pass the request to the next handler
				return c.Next()
			}
		}

		// No matching role was found — the user is authenticated but not authorized
		// to perform this action. Return 403 Forbidden with a descriptive message.
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
			"error": "insufficient permissions",
		})
	}
}
