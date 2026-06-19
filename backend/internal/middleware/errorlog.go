// Package middleware contains HTTP middleware functions for the Golf League API.
// This file emits a structured error log for every 5xx response.
package middleware

// errorlog.go — 5xx response logging.
//
// Every handler records the root cause of a server fault in
// c.Locals("error_detail") via its write<Domain>Error helper. Historically a
// metrics/Loki middleware read that value and emitted an `http.error` log line; it
// was removed in the Sentry migration and never replaced, leaving error_detail with
// no consumer. The result: 5xx faults produced no log and no Sentry Issue (only an
// uncaught *panic* reached Sentry, via the recover/sentryfiber path). This restores
// that visibility — it is the single consumer of error_detail.

import (
	"log/slog"

	"github.com/gofiber/fiber/v2"
)

// ErrorLogger logs a slog.Error for any response with a 5xx status. Because the
// process logger routes Error records to both Sentry Issues (EventLevel) and Sentry
// Logs (LogLevel), each server fault becomes an alertable Issue and a searchable
// `level:error` / `event_type_label:http.error` log line carrying the request and
// root cause. 4xx responses are expected client errors and are deliberately ignored
// so normal validation traffic doesn't generate noise.
//
// Register it AFTER sentryfiber (so c.UserContext() carries the per-request hub) and
// before the routes, so its post-c.Next() inspection sees the final status. Panics
// bypass this (they unwind through c.Next) but are already captured by sentryfiber.
func ErrorLogger() fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Run the rest of the chain first; on return the response status is final.
		err := c.Next()

		status := c.Response().StatusCode()
		if status >= fiber.StatusInternalServerError {
			// error_detail is "<tag>: <cause>" when a handler set it; empty when the
			// 5xx came from elsewhere (e.g. a returned error fiber mapped to 500).
			detail, _ := c.Locals("error_detail").(string)
			slog.ErrorContext(c.UserContext(), "HTTP 5xx response",
				"event_type_label", "http.error",
				"method", c.Method(),
				"path", c.Path(),
				"status", status,
				"error", detail,
			)
		}

		return err
	}
}
