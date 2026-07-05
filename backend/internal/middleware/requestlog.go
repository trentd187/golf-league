// Package middleware contains HTTP middleware functions for the Golf League API.
// This file emits a structured access log for every HTTP request.
package middleware

// requestlog.go — per-request access + slow-request logging.
//
// During the 7/3 502 incident Railway's proxy `http` log stream was empty, so there was no
// record of which requests were in flight or how slow they ran while the backend went
// unresponsive (metrics showed the process alive but idle). This middleware guarantees an
// app-level access trail in BOTH Railway's deploy (stdout) logs and Sentry Logs: method,
// path, status, latency, and caller. Healthy 2xx traffic logs at Info; client/server errors
// and anything at or slower than slowThreshold escalate to Warn so they filter out trivially
// (event_type_label:http.request, slow:true). It complements ErrorLogger, which still opens
// the Issue for 5xx — this only adds the latency + access trail as a searchable Log.
//
// Limitation: a request that never returns from c.Next() (a true hang) cannot be logged
// here. That gap is covered by request timeouts and the /health DB-ping — a hang now fails
// fast into a logged 5xx rather than an invisible 502.

import (
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
)

// RequestLogger returns middleware that logs one access line per request. slowThreshold is
// the latency at or above which a request is flagged slow and escalated to Warn. Register it
// after sentryfiber (so c.UserContext() carries the per-request hub) and before the routes,
// so its post-c.Next() inspection reads the final status.
func RequestLogger(slowThreshold time.Duration) fiber.Handler {
	return func(c *fiber.Ctx) error {
		start := time.Now()
		// Run the rest of the chain first; on return the status and latency are final.
		err := c.Next()
		latency := time.Since(start)

		status := c.Response().StatusCode()
		// userID is set by middleware.Auth on the /api/v1 group; empty for /health and
		// any pre-auth path — that's expected, not an error.
		userID, _ := c.Locals("userID").(string)
		slow := latency >= slowThreshold

		attrs := []any{
			"event_type_label", "http.request",
			"method", c.Method(),
			"path", c.Path(),
			"status", status,
			"latency_ms", latency.Milliseconds(),
			"user_id", userID,
			"slow", slow,
		}

		if status >= fiber.StatusBadRequest || slow {
			slog.WarnContext(c.UserContext(), "http request", attrs...)
		} else {
			slog.InfoContext(c.UserContext(), "http request", attrs...)
		}

		return err
	}
}
