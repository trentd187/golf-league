// idempotency.go — GET /api/v1/idempotency/:key.
//
// Create-side phantom recovery. A non-idempotent POST create can commit server-side while
// every ack is lost on a degraded cellular link; the client then exhausts its retry budget
// and can't learn the new row's id, so it surfaces a scary "could not create" even though
// the row exists (the durable idempotency middleware already prevents a DUPLICATE — this
// closes the UX gap). This endpoint lets the client recover deterministically: it replays
// the stored create response for the SAME Idempotency-Key the client already holds. No
// fuzzy matching, and it works for every create type (round, event, group, guest, team).
// See mobile/utils/savePost.ts and backend/internal/middleware/idempotency.go.
package handlers

import (
	"context"
	"log/slog"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/trentd187/golf-league/internal/middleware"
)

// idempotencyLooker is the slice of DurableIdempotencyStore this handler needs, so tests
// can inject a fake without a database.
type idempotencyLooker interface {
	Lookup(ctx context.Context, key string, userID uuid.UUID) (*middleware.IdempotencyRecord, bool, error)
}

// LookupIdempotentResponse handles GET /api/v1/idempotency/:key. It returns the stored
// create response (original status + body) when a committed record for this caller exists,
// or 404 when the key is unknown/expired/foreign/still-in-flight — indistinguishable to the
// client, which then falls through to its normal failure path.
func LookupIdempotentResponse(store idempotencyLooker) fiber.Handler {
	return func(c *fiber.Ctx) error {
		key := c.Params("key")
		if key == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "idempotency key required"})
		}

		userIDStr, _ := c.Locals("userID").(string)
		userID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		rec, found, err := store.Lookup(c.UserContext(), key, userID)
		if err != nil {
			slog.ErrorContext(c.UserContext(), "Idempotency lookup failed",
				"event_type_label", "create.idempotency_lookup_error",
				"error", err.Error())
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "lookup failed"})
		}
		if !found || rec.ResponseStatus == nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "not found"})
		}

		// A recovered phantom create — the client rescued the row it couldn't ack.
		slog.InfoContext(c.UserContext(), "Idempotent create recovered by key lookup",
			"event_type_label", "create.recovered_by_lookup",
			"idempotency_key", key)

		body := ""
		if rec.ResponseBody != nil {
			body = *rec.ResponseBody
		}
		c.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
		c.Set("Idempotent-Replay", "true")
		return c.Status(*rec.ResponseStatus).SendString(body)
	}
}
