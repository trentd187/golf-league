// correlation.go provides the Correlation middleware that links mobile client
// sessions with backend traces and logs. It reads the X-Correlation-ID request
// header (or generates a new UUID) and:
//   - Attaches it as a "correlation.id" span attribute (visible in Tempo)
//   - Stores it in c.Locals("correlationID") for handlers and logging
//   - Writes the current span's trace ID back as X-Trace-ID on every response
//     so mobile clients can include it in subsequent error log entries
//
// Must be registered AFTER otelfiber so the OTel span already exists.
package middleware

import (
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// Correlation extracts (or generates) a session-scoped correlation ID, attaches
// it to the active OTel span, and writes the span's trace ID back to the response.
func Correlation() fiber.Handler {
	return func(c *fiber.Ctx) error {
		correlationID := c.Get("X-Correlation-ID")
		if _, err := uuid.Parse(correlationID); err != nil {
			// Discard malformed values (e.g. garbled Date+UUID observed in production traces).
			// uuid.Parse("") also returns an error, so the empty-header case is handled here too.
			correlationID = uuid.New().String()
		}

		// Add the correlation ID to the active span so it shows up in Tempo searches.
		span := trace.SpanFromContext(c.UserContext())
		span.SetAttributes(attribute.String("correlation.id", correlationID))

		// Store for use by handlers and log helpers within this request.
		c.Locals("correlationID", correlationID)

		err := c.Next()

		// After the handler chain, the span's trace ID is finalised — write it
		// to the response so mobile clients can link a Loki error entry to this span.
		traceID := trace.SpanFromContext(c.UserContext()).SpanContext().TraceID().String()
		if traceID != "00000000000000000000000000000000" {
			c.Set("X-Trace-ID", traceID)
		}

		return err
	}
}
