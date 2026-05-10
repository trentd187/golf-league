// handlers/users.go
// HTTP handlers for /api/v1/me and /api/v1/users/* routes.
// Each handler parses HTTP input, calls UserService, and maps the result to a status+JSON
// response via writeUserError. All business logic and DB access lives in services.UserService.
//
// Endpoints:
//
//	GET    /api/v1/me                                — caller's own profile (includes role)
//	GET    /api/v1/users?q=                          — search users by name or email
//	GET    /api/v1/users/following                   — list users the caller follows
//	GET    /api/v1/users/me/scorecard-settings       — caller's stat visibility preferences
//	PATCH  /api/v1/users/me/scorecard-settings       — update stat visibility preferences
//	GET    /api/v1/users/:userId                     — public profile for any user
//	GET    /api/v1/users/:userId/stats               — computed career stats for any user
//	GET    /api/v1/users/:userId/rounds              — last 20 completed rounds for a user
//	POST   /api/v1/users/:userId/follow              — follow a user
//	DELETE /api/v1/users/:userId/follow              — unfollow a user
package handlers

import (
	"errors"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/services"
)

// ─── Error helper ─────────────────────────────────────────────────────────────

// writeUserError translates a UserService error to an HTTP response.
// For 5xx it sets c.Locals("error_detail") so the Loki http.error log line
// includes the root cause. Always returns nil.
func writeUserError(c *fiber.Ctx, err error, tag, fallbackMsg string) error {
	var ve *services.ValidationError
	if errors.As(err, &ve) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": ve.Message})
	}
	switch {
	case errors.Is(err, services.ErrUserNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "user not found"})
	case errors.Is(err, services.ErrFollowSelf):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "cannot follow yourself"})
	case errors.Is(err, services.ErrAlreadyFollowing):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "already following"})
	}
	c.Locals("error_detail", tag+": "+err.Error())
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": fallbackMsg})
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

// GetMe returns a handler for GET /api/v1/me.
func GetMe(svc *services.UserService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, ok := c.Locals("userID").(string)
		if !ok || callerIDStr == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Unauthorized"})
		}
		callerID, err := uuid.Parse(callerIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Unauthorized"})
		}

		data, err := svc.GetMe(c.UserContext(), callerID)
		if err != nil {
			return writeUserError(c, err, "user.get_me", "failed to load user")
		}
		return c.JSON(data)
	}
}

// SearchUsers returns a handler for GET /api/v1/users?q=.
func SearchUsers(svc *services.UserService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, _ := c.Locals("userID").(string)
		callerID, err := uuid.Parse(callerIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		results, err := svc.SearchUsers(c.UserContext(), callerID, c.Query("q"))
		if err != nil {
			return writeUserError(c, err, "user.search", "failed to search users")
		}
		return c.JSON(results)
	}
}

// GetUserProfile returns a handler for GET /api/v1/users/:userId.
func GetUserProfile(svc *services.UserService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, _ := c.Locals("userID").(string)
		callerID, err := uuid.Parse(callerIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		targetID, err := uuid.Parse(c.Params("userId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user ID"})
		}

		data, err := svc.GetUserProfile(c.UserContext(), callerID, targetID)
		if err != nil {
			return writeUserError(c, err, "user.get_profile", "failed to load user profile")
		}
		return c.JSON(data)
	}
}

// FollowUser returns a handler for POST /api/v1/users/:userId/follow.
func FollowUser(svc *services.UserService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, _ := c.Locals("userID").(string)
		callerID, err := uuid.Parse(callerIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		targetID, err := uuid.Parse(c.Params("userId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user ID"})
		}

		if err := svc.FollowUser(c.UserContext(), callerID, targetID); err != nil {
			return writeUserError(c, err, "user.follow", "failed to follow user")
		}
		return c.Status(fiber.StatusOK).JSON(fiber.Map{"ok": true})
	}
}

// UnfollowUser returns a handler for DELETE /api/v1/users/:userId/follow.
func UnfollowUser(svc *services.UserService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, _ := c.Locals("userID").(string)
		callerID, err := uuid.Parse(callerIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		targetID, err := uuid.Parse(c.Params("userId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user ID"})
		}

		_ = callerID // auth check only; service handles the delete
		if err := svc.UnfollowUser(c.UserContext(), callerID, targetID); err != nil {
			return writeUserError(c, err, "user.unfollow", "failed to unfollow user")
		}
		return c.SendStatus(fiber.StatusNoContent)
	}
}

// GetFollowing returns a handler for GET /api/v1/users/following.
func GetFollowing(svc *services.UserService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, _ := c.Locals("userID").(string)
		callerID, err := uuid.Parse(callerIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		results, err := svc.GetFollowing(c.UserContext(), callerID)
		if err != nil {
			return writeUserError(c, err, "user.get_following", "failed to load following list")
		}
		return c.JSON(results)
	}
}

// GetUserStats returns a handler for GET /api/v1/users/:userId/stats?filter=all_time|last_20.
func GetUserStats(svc *services.UserService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, _ := c.Locals("userID").(string)
		if _, err := uuid.Parse(callerIDStr); err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		targetID, err := uuid.Parse(c.Params("userId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user ID"})
		}

		data, err := svc.GetUserStats(c.UserContext(), targetID, c.Query("filter", "all_time"))
		if err != nil {
			return writeUserError(c, err, "user.get_stats", "failed to load user stats")
		}
		return c.JSON(data)
	}
}

// GetUserRounds returns a handler for GET /api/v1/users/:userId/rounds.
func GetUserRounds(svc *services.UserService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, _ := c.Locals("userID").(string)
		if _, err := uuid.Parse(callerIDStr); err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		targetID, err := uuid.Parse(c.Params("userId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user ID"})
		}

		results, err := svc.GetUserRounds(c.UserContext(), targetID)
		if err != nil {
			return writeUserError(c, err, "user.get_rounds", "failed to load user rounds")
		}
		return c.JSON(results)
	}
}

// GetScorecardSettings returns a handler for GET /api/v1/users/me/scorecard-settings.
func GetScorecardSettings(svc *services.UserService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, ok := c.Locals("userID").(string)
		if !ok || callerIDStr == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}
		callerID, err := uuid.Parse(callerIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		data, err := svc.GetScorecardSettings(c.UserContext(), callerID)
		if err != nil {
			return writeUserError(c, err, "user.get_scorecard_settings", "failed to load settings")
		}
		return c.JSON(data)
	}
}

// UpsertScorecardSettings returns a handler for PATCH /api/v1/users/me/scorecard-settings.
func UpsertScorecardSettings(svc *services.UserService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, ok := c.Locals("userID").(string)
		if !ok || callerIDStr == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}
		callerID, err := uuid.Parse(callerIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		var body services.ScorecardSettingsInput
		if err := c.BodyParser(&body); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}

		data, err := svc.UpsertScorecardSettings(c.UserContext(), callerID, body)
		if err != nil {
			// Preserve the error_detail visibility hook for Loki — writeUserError sets it for 5xx.
			return writeUserError(c, err, "user.upsert_scorecard_settings", "failed to save settings")
		}
		return c.JSON(data)
	}
}
