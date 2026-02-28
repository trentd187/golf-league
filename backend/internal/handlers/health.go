// Package handlers contains the HTTP route handler functions for the Golf League API.
// Each handler corresponds to one API endpoint and is responsible for reading the
// request, performing any business logic, and writing a response.
package handlers

import "github.com/gofiber/fiber/v2"

// HealthCheck handles GET /health.
// It returns a simple JSON response indicating the server is alive and reachable.
// This endpoint is intentionally lightweight — no database queries, no authentication.
// It's used by:
//   - Docker/Kubernetes readiness and liveness probes to decide if the container is healthy
//   - Load balancers to check whether to send traffic to this instance
//   - Developers checking if the server started correctly
//
// c *fiber.Ctx is the request context — it gives access to the request data and
// methods for writing the response. All Fiber handlers follow this same signature.
func HealthCheck(c *fiber.Ctx) error {
	// c.JSON serializes the map to JSON and sends it with a 200 OK status.
	// fiber.Map is just a shorthand for map[string]interface{}.
	return c.JSON(fiber.Map{"status": "ok"})
}
