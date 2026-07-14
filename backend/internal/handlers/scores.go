// handlers/scores.go
// HTTP handlers for scorecard retrieval, score entry, and advanced hole statistics.
// All business logic lives in internal/services.ScoreService. Each handler
// here parses HTTP input (URL params, JSON body), calls the service, and
// translates the (value, error) result into HTTP status + JSON via writeScoreError.
//
// Endpoints:
//
//	GET /api/v1/rounds/:roundId/scorecard
//	PUT /api/v1/rounds/:roundId/players/:roundPlayerId/handicap
//	PUT /api/v1/rounds/:roundId/players/:roundPlayerId/scores
//	PUT /api/v1/rounds/:roundId/players/:roundPlayerId/hole-stats
package handlers

import (
	"errors"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/services"
)

// ─── Request types ────────────────────────────────────────────────────────────

// SetHandicapRequest is the JSON body for PUT .../handicap.
type SetHandicapRequest struct {
	CourseHandicap int `json:"course_handicap"`
}

// UpsertScoresRequest is the JSON body for PUT .../scores.
type UpsertScoresRequest struct {
	Scores []services.ScoreInput `json:"scores"`
}

// UpsertHoleStatsRequest is the JSON body for PUT .../hole-stats.
type UpsertHoleStatsRequest struct {
	Stats []services.HoleStatInput `json:"stats"`
}

// ─── Error helper ─────────────────────────────────────────────────────────────

// writeScoreError translates a service error to an HTTP response.
// For 5xx it sets c.Locals("error_detail") so the http.error log line
// (emitted by middleware.ErrorLogger to Sentry) includes the root cause.
// Always returns nil.
func writeScoreError(c *fiber.Ctx, err error, tag, fallbackMsg string) error {
	var ve *services.ValidationError
	if errors.As(err, &ve) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: ve.Message})
	}
	switch {
	case errors.Is(err, services.ErrRoundNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{jsonKeyError: "round not found"})
	case errors.Is(err, services.ErrRoundPlayerNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{jsonKeyError: "round player not found"})
	case errors.Is(err, services.ErrScoreForbidden):
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{jsonKeyError: "not authorized to modify scores for this player"})
	case errors.Is(err, services.ErrRoundNotActive):
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{jsonKeyError: "round is not active — scores can only be entered while the round is in progress"})
	case errors.Is(err, services.ErrHandicapRequired):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{jsonKeyError: "handicap must be set before entering scores for this round"})
	}
	c.Locals("error_detail", tag+": "+err.Error())
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{jsonKeyError: fallbackMsg})
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

// GetEventScorecards returns a handler for GET /api/v1/events/:id/scorecards.
//
// Every completed round in the event, in ONE response. The event detail screen used to build
// its leaderboard with a useQueries() fan-out — one /rounds/:id/scorecard request per completed
// round — and it polled every one of them on the 60s live interval. A 20-round league meant 20
// concurrent requests on tab open and 20 more every minute, over the same cellular links the
// entire save path was hardened for. This is the same N+1 that GET /users/:id/scorecards
// already removed from the stats screen.
func GetEventScorecards(svc *services.ScoreService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		eventID, err := uuid.Parse(c.Params("id"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid event ID"})
		}

		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)
		callerID, _ := uuid.Parse(userIDStr)

		cards, err := svc.GetEventScorecards(c.UserContext(), eventID, callerID, userRole)
		if err != nil {
			return writeScoreError(c, err, "score.get_event_scorecards", "failed to load event scorecards")
		}
		return c.JSON(cards)
	}
}

// GetRoundScorecard returns a handler for GET /api/v1/rounds/:roundId/scorecard.
// Any authenticated user may view the scorecard; no write permission is required.
func GetRoundScorecard(svc *services.ScoreService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		roundID, err := uuid.Parse(c.Params("roundId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid round ID"})
		}

		// Auth is enforced by middleware; callerID falls back to uuid.Nil on parse
		// failure, which causes IsOrganizer to return false — scorecard is still readable.
		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)
		callerID, _ := uuid.Parse(userIDStr)

		data, err := svc.GetScorecard(c.UserContext(), roundID, callerID, userRole)
		if err != nil {
			return writeScoreError(c, err, "score.get_scorecard", "failed to load scorecard")
		}
		return c.JSON(data)
	}
}

// SetPlayerHandicap returns a handler for PUT .../handicap.
// Sets the playing handicap for a single round_player.
// Caller must share a group with the target player, or be an organizer/admin.
func SetPlayerHandicap(svc *services.ScoreService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		roundID, err := uuid.Parse(c.Params("roundId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid round ID"})
		}
		roundPlayerID, err := uuid.Parse(c.Params("roundPlayerId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid round player ID"})
		}

		var req SetHandicapRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid request body"})
		}

		callerID, userRole, ok := authUser(c)
		if !ok {
			return nil
		}

		if err := svc.SetHandicap(c.UserContext(), roundID, roundPlayerID, callerID, userRole, req.CourseHandicap); err != nil {
			return writeScoreError(c, err, "score.set_handicap", "failed to save handicap")
		}
		return c.JSON(fiber.Map{"course_handicap": req.CourseHandicap})
	}
}

// UpsertPlayerScores returns a handler for PUT .../scores.
// Bulk upserts all hole scores for one player. Safe to call multiple times.
// Other players watching the round pick the change up on their next 60s poll — the
// server pushes nothing. (A WebSocket used to echo every save back to the saving
// device, whose refetch reflowed the scorecard mid-tap and ate FIR/GIR presses.)
func UpsertPlayerScores(svc *services.ScoreService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		roundID, err := uuid.Parse(c.Params("roundId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid round ID"})
		}
		roundPlayerID, err := uuid.Parse(c.Params("roundPlayerId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid round player ID"})
		}

		var req UpsertScoresRequest
		if err := c.BodyParser(&req); err != nil || len(req.Scores) == 0 {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "scores array is required"})
		}

		callerID, userRole, ok := authUser(c)
		if !ok {
			return nil
		}

		saved, err := svc.UpsertScores(c.UserContext(), roundID, roundPlayerID, callerID, userRole, req.Scores)
		if err != nil {
			return writeScoreError(c, err, "score.upsert_scores", "failed to save scores")
		}
		return c.JSON(fiber.Map{"saved": saved})
	}
}

// UpsertHoleStats returns a handler for PUT .../hole-stats.
// Bulk upserts advanced per-hole stats for one player. Safe to call multiple times.
// Like UpsertPlayerScores, it pushes nothing — peers poll.
func UpsertHoleStats(svc *services.ScoreService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		roundID, err := uuid.Parse(c.Params("roundId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid round ID"})
		}
		roundPlayerID, err := uuid.Parse(c.Params("roundPlayerId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid round player ID"})
		}

		var req UpsertHoleStatsRequest
		if err := c.BodyParser(&req); err != nil || len(req.Stats) == 0 {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "stats array is required"})
		}

		callerID, userRole, ok := authUser(c)
		if !ok {
			return nil
		}

		saved, err := svc.UpsertHoleStats(c.UserContext(), roundID, roundPlayerID, callerID, userRole, req.Stats)
		if err != nil {
			return writeScoreError(c, err, "score.upsert_hole_stats", "failed to save stats")
		}
		return c.JSON(fiber.Map{"saved": saved})
	}
}
