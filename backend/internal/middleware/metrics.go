// metrics.go provides the HTTPMetrics middleware that records request count,
// latency, and a structured access log entry for every HTTP request.
// It uses the Fiber route pattern (e.g. "/rounds/:roundId") rather than the
// raw URL to prevent UUID-per-series cardinality explosions on the Mimir free tier.
package middleware

import (
	"context"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/trentd187/golf-league/internal/observability"
)

// HTTPMetrics returns a Fiber middleware that records per-request metrics.
// Register this after otelfiber so the OTel span context is already set.
func HTTPMetrics(m *observability.Metrics) fiber.Handler {
	return func(c *fiber.Ctx) error {
		start := time.Now()
		err := c.Next()
		duration := time.Since(start)

		// Fiber sets the matched route pattern after Next() returns.
		// Fall back to "unknown" for unmatched paths (404s) so they don't
		// create high-cardinality series in Mimir.
		route := c.Route().Path
		if route == "" {
			route = "unknown"
		}

		statusCode := c.Response().StatusCode()
		m.RecordHTTP(context.Background(), c.Method(), route, statusCode, duration)

		// Emit a structured access log line for every request except /health.
		// Railway polls /health every few seconds; logging it adds volume without value.
		// correlation_id and user_id are appended when set by their respective middleware
		// so each Loki line is linkable to a Tempo trace and a specific user.
		if route != "/health" {
			args := []any{
				"method", c.Method(),
				"route", route,
				"status", statusCode,
				"latency_ms", duration.Milliseconds(),
			}
			if cid, ok := c.Locals("correlationID").(string); ok && cid != "" {
				args = append(args, "correlation_id", cid)
			}
			if uid, ok := c.Locals("userID").(string); ok && uid != "" {
				args = append(args, "user_id", uid)
			}
			observability.LogInfo(c.UserContext(), "http.request", "HTTP request", args...)
		}

		// Log 5xx errors so they appear in Loki with full request context.
		// Handlers that produce a 5xx store the underlying cause in c.Locals("error_detail")
		// so it flows through here rather than being emitted as a separate log entry that
		// can get lost in the batch queue before the process shuts down.
		if statusCode >= 500 {
			args := []any{
				"method", c.Method(),
				"route", route,
				"status", statusCode,
			}
			if detail, ok := c.Locals("error_detail").(string); ok && detail != "" {
				args = append(args, "error", detail)
			}
			observability.LogError(c.UserContext(), "http.error", "HTTP 5xx response", args...)
		}

		return err
	}
}
