// Package middleware contains HTTP middleware functions for the Golf League API.
// This file bounds each request's context with a deadline.
package middleware

// requesttimeout.go — per-request context deadline.
//
// Handlers pass c.UserContext() into the service layer, which uses it for GORM DB calls.
// Without a deadline a hung query — e.g. one waiting on an exhausted connection pool, the
// 7/3 502 failure mode — parks the goroutine indefinitely and the request eventually
// surfaces as a silent proxy 502. This middleware attaches a deadline so GORM aborts the
// query (context.DeadlineExceeded), the service returns an error, and it becomes a LOGGED
// 5xx that reaches Sentry: fail fast, not hang.
//
// It wraps c.UserContext() (preserving the per-request Sentry hub sentryfiber set), so
// register it AFTER sentryfiber. Applied to the REST /api/v1 group only — the live-score
// WebSocket is long-lived and registered on `app` outside the group, so it is exempt.

import (
	"context"
	"time"

	"github.com/gofiber/fiber/v2"
)

// RequestTimeout returns middleware that gives each request a bounded context deadline.
func RequestTimeout(d time.Duration) fiber.Handler {
	return func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(c.UserContext(), d)
		defer cancel()
		c.SetUserContext(ctx)
		return c.Next()
	}
}
