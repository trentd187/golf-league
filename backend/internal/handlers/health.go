// Package handlers contains the HTTP route handler functions for the Golf League API.
// Each handler corresponds to one API endpoint and is responsible for reading the
// request, performing any business logic, and writing a response.
package handlers

import "github.com/gofiber/fiber/v2"

// HealthCheck handles GET /health.
// Lightweight liveness check used by Railway and load balancers — no database, no auth.
func HealthCheck(c *fiber.Ctx) error {
	// fiber.Map is shorthand for map[string]interface{}
	return c.JSON(fiber.Map{"status": "ok"})
}
