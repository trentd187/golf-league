// Package handlers contains the HTTP route handler functions for the Golf League API.
// Each handler corresponds to one API endpoint and is responsible for reading the
// request, performing any business logic, and writing a response.
package handlers

import (
	"context"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
)

// DBPinger is the slice of the database the health check needs — just a context ping.
// The *sql.DB behind GORM (db.DB()) satisfies it; tests inject a fake for the up/down paths.
type DBPinger interface {
	PingContext(ctx context.Context) error
}

// HealthCheck handles GET /health — a readiness probe confirming the process is up AND the
// database is reachable. It pings the DB with a short timeout so a wedged connection pool
// (the 7/3 502 mode: process alive, DB unreachable) surfaces as a 503 the load balancer can
// act on. Previously the check ignored the DB and returned 200 while every real request
// 502'd, so Railway kept routing into the stuck backend. A failed ping is logged as an
// Issue-level event (event_type_label:health.db_unreachable) so a DB outage is alertable.
func HealthCheck(db DBPinger) fiber.Handler {
	return func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(c.UserContext(), 2*time.Second)
		defer cancel()

		start := time.Now()
		if err := db.PingContext(ctx); err != nil {
			slog.ErrorContext(c.UserContext(), "health check: database unreachable",
				"event_type_label", "health.db_unreachable",
				"error", err.Error(),
				"latency_ms", time.Since(start).Milliseconds())
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"status": "unhealthy", "db": "down"})
		}
		return c.JSON(fiber.Map{"status": "ok", "db": "up"})
	}
}
