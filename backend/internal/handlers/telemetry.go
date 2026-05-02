// telemetry.go provides the PostMobileLogs handler that acts as an authenticated
// proxy between the React Native mobile app and Grafana Cloud Loki. Mobile clients
// cannot safely embed Loki credentials (they would be extractable from the APK),
// so they POST structured log entries to this endpoint using their Supabase JWT.
// The handler forwards each entry to Loki via the LokiPusher interface.
package handlers

import (
	"context"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
)

// LokiPusher is the interface satisfied by *observability.LokiHandler.
// Using an interface here lets tests inject a fake pusher without a real Loki instance.
type LokiPusher interface {
	Log(ctx context.Context, level slog.Level, msg string, args ...any)
}

// MobileLogEntry is one structured log event from the mobile client.
// Level defaults to "info" when the field is absent or unrecognised.
// Fields is a free-form map so callers can attach any contextual data
// (e.g. correlation_id, trace_id, screen name).
type MobileLogEntry struct {
	Level     string         `json:"level"`      // "debug" | "info" | "warn" | "error"
	EventType string         `json:"event_type"` // e.g. "app.foregrounded", "react.error"
	Message   string         `json:"message"`
	Timestamp string         `json:"timestamp"` // RFC3339; server time used when absent/invalid
	Fields    map[string]any `json:"fields"`
}

// MobileLogsRequest is the body for POST /api/v1/telemetry/logs.
type MobileLogsRequest struct {
	Entries []MobileLogEntry `json:"entries"`
}

// PostMobileLogs returns a Fiber handler that validates and forwards mobile log
// entries to Loki. Requests without a valid auth context still reach this handler
// (the Auth middleware runs before it), so the Supabase JWT provides the auth boundary.
//
// Validation:
//   - Missing or unparseable body → 400
//   - Empty entries list → 400
//   - More than 100 entries → 400 (free-tier Loki budget cap)
//   - Entries with empty event_type are skipped (not rejected) to tolerate partial data
func PostMobileLogs(pusher LokiPusher) fiber.Handler {
	return func(c *fiber.Ctx) error {
		var req MobileLogsRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "invalid request body",
			})
		}

		if len(req.Entries) == 0 {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "entries must not be empty",
			})
		}

		if len(req.Entries) > 100 {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "too many entries: maximum is 100 per request",
			})
		}

		for _, entry := range req.Entries {
			// Skip entries without an event type rather than rejecting the whole batch.
			if entry.EventType == "" {
				continue
			}

			level := parseMobileLevel(entry.Level)

			ts, err := time.Parse(time.RFC3339, entry.Timestamp)
			if err != nil {
				ts = time.Now()
			}

			// Build the args list from the Fields map plus fixed keys.
			// The source="mobile" label lets Loki queries distinguish mobile-originated entries.
			args := []any{
				"event_type", entry.EventType,
				"source", "mobile",
				"ts", ts.Format(time.RFC3339),
			}
			for k, v := range entry.Fields {
				args = append(args, k, v)
			}

			pusher.Log(c.UserContext(), level, entry.Message, args...)
		}

		return c.SendStatus(fiber.StatusNoContent)
	}
}

// parseMobileLevel maps the mobile client's string level to slog.Level.
// Unrecognised or empty values default to slog.LevelInfo.
func parseMobileLevel(s string) slog.Level {
	switch s {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
