// Package handlers contains HTTP route handler functions for the Golf League API.
// This file handles the /api/v1/users and /api/v1/me routes.
//
// Endpoints:
//
//	GET  /api/v1/users              — list all users except the caller (powers Add Member picker)
//	PATCH /api/v1/me/profile-image  — upload a profile photo, proxied to Clerk's Backend API
//
// Why the profile image upload is proxied here:
//
//	Clerk's Frontend API (the SDK's built-in setProfileImage) uses browser-cookie auth and
//	rejects non-browser clients. The mobile app can't call it directly. Instead, we receive
//	the image with normal JWT auth and forward it to Clerk's Backend API using the secret key.
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
// We only expose the fields needed to identify and search for a user.
type UserSummaryResponse struct {
	ID          string `json:"id"`           // Internal UUID
	DisplayName string `json:"display_name"` // The name shown in the app
	Email       string `json:"email"`        // Used as a secondary search key
}

// GetUsers returns a handler for GET /api/v1/users.
// Returns all registered users in the system, excluding the caller.
// Results are sorted alphabetically by display_name.
//
// Access: any authenticated user (no role restriction).
// The caller is excluded so the mobile "Add Member" list doesn't show yourself.
func GetUsers(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Get the calling user's ID so we can exclude them from the results.
		// The Auth middleware stores this as a string in c.Locals("userID").
		callerIDStr, _ := c.Locals("userID").(string)

		var users []models.User
		// WHERE id != caller: exclude the current user from the list
		// ORDER BY display_name: alphabetical order for easier searching in the mobile picker
		db.Where("id != ?", callerIDStr).
			Order("display_name ASC").
			Find(&users)

		// Build the response slice — only include the fields needed by the mobile app
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
// It receives the image file from the mobile app and proxies it to Clerk's Backend API,
// which stores the image and updates user.imageUrl on the Clerk side.
//
// Why proxy instead of calling Clerk directly from mobile?
//
//	Clerk's Frontend API (what setProfileImage() uses) requires browser-cookie auth and
//	explicitly rejects native mobile clients with "Unable to authenticate this browser".
//	Clerk's Backend API uses the secret key — safe only for server-side calls, never in
//	the mobile app bundle.
//
// Flow:
//  1. Mobile sends multipart/form-data with a "file" field (JPEG/PNG)
//     authenticated with the normal Clerk session JWT.
//  2. This handler verifies the JWT (via the Auth middleware), looks up the caller's
//     Clerk user ID, and forwards the file to:
//     POST https://api.clerk.com/v1/users/{clerkId}/profile_image
//     authenticated with the Clerk secret key.
//  3. Returns 200 on success; propagates Clerk's error JSON on failure.
func UpdateProfileImage(cfg *config.Config, db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// --- 1. Identify the caller ---
		// The Auth middleware stores the caller's internal UUID as "userID" in locals.
		// We use it to look up the User row and get their Clerk ID.
		callerIDStr, ok := c.Locals("userID").(string)
		if !ok || callerIDStr == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Unauthorized"})
		}

		// Fetch only the fields we need — no need to load the whole user graph.
		var user models.User
		if err := db.Select("id, clerk_id").First(&user, "id = ?", callerIDStr).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "User not found"})
		}

		// ClerkID is a nullable pointer; if it's nil the user was never properly synced.
		if user.ClerkID == nil || *user.ClerkID == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "User has no Clerk ID"})
		}

		// --- 2. Read the uploaded file ---
		// c.FormFile("file") parses the first file attached under the "file" field.
		// Returns an error if no file was provided or the request isn't multipart.
		fileHeader, err := c.FormFile("file")
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "No file provided — expected a multipart/form-data field named \"file\""})
		}

		// Open the uploaded file so we can stream it into the outgoing request body.
		src, err := fileHeader.Open()
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Could not read uploaded file"})
		}
		defer src.Close()

		// --- 3. Build the multipart body for Clerk's Backend API ---
		// We re-encode the file as multipart because Clerk's API expects "file" as the
		// field name and needs the Content-Type on the part to be the image MIME type.
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)

		// Manually set the part headers so we can include Content-Type explicitly.
		// If we used writer.CreateFormFile(), it always sets Content-Type: application/octet-stream,
		// which Clerk rejects. We need the real MIME type (e.g. image/jpeg).
		// textproto.MIMEHeader is the standard type for MIME headers (map[string][]string).
		partHeader := make(textproto.MIMEHeader)
		partHeader.Set("Content-Disposition",
			fmt.Sprintf(`form-data; name="file"; filename="%s"`, fileHeader.Filename))
		// Preserve the MIME type the mobile client sent (e.g. "image/jpeg", "image/png").
		// If the client didn't set one, fall back to the safe default.
		contentType := fileHeader.Header.Get("Content-Type")
		if contentType == "" {
			contentType = "image/jpeg"
		}
		partHeader.Set("Content-Type", contentType)

		part, err := writer.CreatePart(partHeader)
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Could not create multipart part"})
		}

		// Stream the file bytes into the part.
		// io.Copy reads from src and writes to part without loading everything into memory.
		if _, err := io.Copy(part, src); err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Could not copy file data"})
		}

		// Finalize the multipart body — writes the closing boundary.
		writer.Close()

		// --- 4. POST to Clerk's Backend API ---
		// Clerk's Backend API: https://api.clerk.com/v1/users/{userId}/profile_image
		// Auth: Bearer <CLERK_SECRET_KEY> (server-side secret, never exposed to the client)
		clerkURL := fmt.Sprintf("https://api.clerk.com/v1/users/%s/profile_image", *user.ClerkID)

		// http.NewRequestWithContext ties the request lifetime to the Fiber request context
		// so it is cancelled if the client disconnects.
		req, err := http.NewRequestWithContext(c.Context(), http.MethodPost, clerkURL, &body)
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Could not build Clerk request"})
		}
		req.Header.Set("Authorization", "Bearer "+cfg.ClerkSecretKey)
		// writer.FormDataContentType() returns the full Content-Type header with the
		// multipart boundary string that Clerk needs to parse our request body correctly.
		req.Header.Set("Content-Type", writer.FormDataContentType())

		// 30-second timeout is generous but prevents a hung Clerk upload blocking forever.
		httpClient := &http.Client{Timeout: 30 * time.Second}
		resp, err := httpClient.Do(req)
		if err != nil {
			return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"error": "Upload to Clerk failed: " + err.Error()})
		}
		defer resp.Body.Close()

		// --- 5. Return the result ---
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			// Forward Clerk's error JSON directly — it contains a human-readable message
			// that we surface in the mobile app alert.
			var clerkErr interface{}
			if jsonErr := json.NewDecoder(resp.Body).Decode(&clerkErr); jsonErr != nil {
				return c.Status(resp.StatusCode).JSON(fiber.Map{"error": fmt.Sprintf("Clerk returned status %d", resp.StatusCode)})
			}
			return c.Status(resp.StatusCode).JSON(clerkErr)
		}

		return c.JSON(fiber.Map{"success": true})
	}
}
