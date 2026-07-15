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

// JWKSCounter reports how many Supabase verifying keys are cached, and whether the key set was
// initialised at all. middleware.JWKSKeyCount satisfies it; tests inject a fake.
type JWKSCounter func(ctx context.Context) (count int, ok bool)

// HealthCheck handles GET /health — a readiness probe confirming the process is up, the
// database is reachable, AND we hold Supabase verifying keys.
//
// Both dependencies are checked because a failure in either makes the service useless while
// leaving the process perfectly alive:
//
//   - DB unreachable (the 7/3 502 mode: process alive, pool wedged). The check used to ignore
//     the DB and return 200 while every real request 502'd, so Railway kept routing into the
//     stuck backend.
//   - ZERO JWKS KEYS. If Supabase's JWKS was unreachable at boot, the server came up with an
//     empty key set and 401'd EVERY authenticated request — a total auth outage — while this
//     endpoint cheerfully returned 200, so Railway never restarted it. (The boot itself is now
//     fatal on an unreachable JWKS; this covers the case where the key set empties out later,
//     which no startup check can catch.)
//
// A nil jwks skips the key check — used by tests and any deployment without auth wired up.
// Each failure is logged at Issue level with a stable event_type_label so it is alertable.
func HealthCheck(db DBPinger, jwks JWKSCounter) fiber.Handler {
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

		if jwks != nil {
			count, ok := jwks(ctx)
			if !ok || count == 0 {
				slog.ErrorContext(c.UserContext(), "health check: no Supabase verifying keys — every request will 401",
					"event_type_label", "health.jwks_empty",
					"key_count", count,
					"initialised", ok)
				return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
					"status": "unhealthy", "db": "up", "jwks": "empty",
				})
			}
		}

		return c.JSON(fiber.Map{"status": "ok", "db": "up", "jwks": "ok"})
	}
}
