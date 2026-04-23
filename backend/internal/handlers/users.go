// Package handlers contains HTTP route handler functions for the Golf League API.
// This file handles the /api/v1/users and /api/v1/me routes.
//
// Endpoints:
//
//	GET /api/v1/me    — return the caller's own profile (including role)
//	GET /api/v1/users — list all users except the caller
package handlers

import (
	"github.com/gofiber/fiber/v2"
	"github.com/trentd187/golf-league/internal/models"
	"gorm.io/gorm"
)

// MeResponse is the shape returned by GET /api/v1/me.
// Includes the role field which lives only in our DB (not in the Supabase JWT).
type MeResponse struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
	AvatarURL   string `json:"avatar_url,omitempty"`
	Role        string `json:"role"`
}

// GetMe returns a handler for GET /api/v1/me.
// Returns the authenticated caller's own profile including their platform role.
func GetMe(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, ok := c.Locals("userID").(string)
		if !ok || callerIDStr == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Unauthorized"})
		}

		var user models.User
		if err := db.First(&user, "id = ?", callerIDStr).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "User not found"})
		}

		avatarURL := ""
		if user.AvatarURL != nil {
			avatarURL = *user.AvatarURL
		}

		return c.JSON(MeResponse{
			ID:          user.ID.String(),
			DisplayName: user.DisplayName,
			Email:       user.Email,
			AvatarURL:   avatarURL,
			Role:        string(user.Role),
		})
	}
}

// UserSummaryResponse is the trimmed-down user shape returned by GET /api/v1/users.
type UserSummaryResponse struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
}

// GetUsers returns a handler for GET /api/v1/users.
// Returns all registered users except the caller, sorted alphabetically.
// Access: any authenticated user (powers the "Add Member" picker).
func GetUsers(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, _ := c.Locals("userID").(string)

		var users []models.User
		db.Where("id != ?", callerIDStr).
			Order("display_name ASC").
			Find(&users)

		response := make([]UserSummaryResponse, 0, len(users))
		for _, u := range users {
			response = append(response, UserSummaryResponse{
				ID:          u.ID.String(),
				DisplayName: u.DisplayName,
				Email:       u.Email,
			})
		}

		return c.JSON(response)
	}
}
