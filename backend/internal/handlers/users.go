// Package handlers contains HTTP route handler functions for the Golf League API.
// This file handles the /api/v1/users and /api/v1/me routes.
//
// Endpoints:
//
//	GET  /api/v1/users              — list all users except the caller
//	PATCH /api/v1/me/profile-image  — upload a profile photo, proxied to Clerk's Backend API
//
// The profile image upload is proxied here because Clerk's Frontend API (used by the
// SDK's built-in setProfileImage) uses browser-cookie auth and rejects native clients.
// We receive the image with normal JWT auth and forward it to Clerk's Backend API
// using the secret key.
package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/trentd187/golf-league/internal/config"
	"github.com/trentd187/golf-league/internal/models"
	"gorm.io/gorm"
)

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

// UpdateProfileImage handles PATCH /api/v1/me/profile-image.
// Receives the image from the mobile app and proxies it to Clerk's Backend API.
//
// Why proxy instead of calling Clerk directly from mobile?
//   - Clerk's Frontend API (setProfileImage) requires browser-cookie auth and rejects native clients.
//   - Clerk's Backend API uses the secret key — safe only for server-side calls.
//
// Flow:
//  1. Mobile sends multipart/form-data with a "file" field authenticated with the Clerk session JWT.
//  2. This handler verifies the JWT (via Auth middleware), looks up the caller's Clerk user ID,
//     and forwards the file to POST https://api.clerk.com/v1/users/{clerkId}/profile_image
//     authenticated with the Clerk secret key.
//  3. Returns 200 on success; propagates Clerk's error JSON on failure.
func UpdateProfileImage(cfg *config.Config, db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, ok := c.Locals("userID").(string)
		if !ok || callerIDStr == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Unauthorized"})
		}

		var user models.User
		if err := db.Select("id, clerk_id").First(&user, "id = ?", callerIDStr).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "User not found"})
		}

		// ClerkID is a nullable pointer; nil means the user was never properly synced.
		if user.ClerkID == nil || *user.ClerkID == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "User has no Clerk ID"})
		}

		fileHeader, err := c.FormFile("file")
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "No file provided — expected a multipart/form-data field named \"file\""})
		}

		src, err := fileHeader.Open()
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Could not read uploaded file"})
		}
		defer src.Close()

		// Re-encode the file as multipart for Clerk's API.
		// We use CreatePart (not CreateFormFile) to set an explicit Content-Type,
		// because CreateFormFile always uses application/octet-stream and Clerk rejects that.
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)

		// textproto.MIMEHeader is the standard type for MIME part headers (map[string][]string).
		partHeader := make(textproto.MIMEHeader)
		partHeader.Set("Content-Disposition",
			fmt.Sprintf(`form-data; name="file"; filename="%s"`, fileHeader.Filename))
		contentType := fileHeader.Header.Get("Content-Type")
		if contentType == "" {
			contentType = "image/jpeg"
		}
		partHeader.Set("Content-Type", contentType)

		part, err := writer.CreatePart(partHeader)
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Could not create multipart part"})
		}

		if _, err := io.Copy(part, src); err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Could not copy file data"})
		}

		writer.Close()

		clerkURL := fmt.Sprintf("https://api.clerk.com/v1/users/%s/profile_image", *user.ClerkID)

		// http.NewRequestWithContext ties the request lifetime to the Fiber context
		// so it is cancelled if the client disconnects.
		req, err := http.NewRequestWithContext(c.Context(), http.MethodPost, clerkURL, &body)
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Could not build Clerk request"})
		}
		req.Header.Set("Authorization", "Bearer "+cfg.ClerkSecretKey)
		// FormDataContentType returns the full Content-Type header with the multipart boundary.
		req.Header.Set("Content-Type", writer.FormDataContentType())

		httpClient := &http.Client{Timeout: 30 * time.Second}
		resp, err := httpClient.Do(req)
		if err != nil {
			return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"error": "Upload to Clerk failed: " + err.Error()})
		}
		defer resp.Body.Close()

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			// Forward Clerk's error JSON directly — it contains human-readable messages.
			var clerkErr interface{}
			if jsonErr := json.NewDecoder(resp.Body).Decode(&clerkErr); jsonErr != nil {
				return c.Status(resp.StatusCode).JSON(fiber.Map{"error": fmt.Sprintf("Clerk returned status %d", resp.StatusCode)})
			}
			return c.Status(resp.StatusCode).JSON(clerkErr)
		}

		return c.JSON(fiber.Map{"success": true})
	}
}
