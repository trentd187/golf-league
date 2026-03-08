// Package middleware contains HTTP middleware functions for the Golf League API.
// Middleware runs on every request before route handlers — the right place for
// cross-cutting concerns like authentication and role checking.
package middleware

import (
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"

	// keyfunc fetches Clerk's public JWKS keys, caches them, and handles key rotation.
	"github.com/MicahParks/keyfunc/v3"
	"github.com/trentd187/golf-league/internal/config"
	"github.com/trentd187/golf-league/internal/models"

	"gorm.io/gorm"
)

// Claims defines the data we expect inside a Clerk JWT payload.
// Standard fields (Subject = Clerk user ID, expiry, etc.) come from jwt.RegisteredClaims.
// The custom claims below are added via the Clerk dashboard JWT template:
//
//	"role":  "{{user.public_metadata.role}}"
//	"email": "{{user.primary_email_address}}"
//	"name":  "{{user.full_name}}"
type Claims struct {
	jwt.RegisteredClaims
	Role  string `json:"role"` // "admin", "manager", or "user"
	Email string `json:"email"`
	Name  string `json:"name"`
}

// bearerPrefix is the standard HTTP Authorization header prefix for JWTs.
const bearerPrefix = "Bearer "

// Auth returns a Fiber middleware handler that:
//  1. Validates the JWT from the "Authorization: Bearer <token>" header.
//  2. Finds the matching user in our database (or creates one on first visit).
//  3. Syncs the user's role, name, and email from the JWT into the database.
//  4. Stores the user's internal UUID and role in c.Locals for downstream handlers.
//
// The JWKS key function is initialized once here (at server startup) via a closure
// and reused on every request, avoiding repeated network calls to Clerk.
func Auth(cfg *config.Config, db *gorm.DB) fiber.Handler {
	// Fetch Clerk's JWKS at startup and cache it. keyfunc handles automatic key rotation.
	// Without the JWKS we cannot verify any token — fatal at startup, not silently at request time.
	jwks, err := keyfunc.NewDefault([]string{cfg.ClerkJWKSURL})
	if err != nil {
		log.Fatalf("Failed to load Clerk JWKS — is CLERK_JWKS_URL set? %v", err)
	}

	return func(c *fiber.Ctx) error {
		authHeader := c.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, bearerPrefix) {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "missing or invalid authorization header",
			})
		}

		tokenStr := strings.TrimPrefix(authHeader, bearerPrefix)

		// jwt.ParseWithClaims verifies the cryptographic signature, the key ID (kid),
		// and the expiry claim. An attacker cannot forge a valid signature without
		// Clerk's private key.
		token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, jwks.Keyfunc)
		if err != nil || !token.Valid {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "invalid token",
			})
		}

		claims, ok := token.Claims.(*Claims)
		if !ok {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "invalid token claims",
			})
		}

		// claims.Subject is the standard JWT "sub" field — Clerk sets it to the Clerk user ID.
		clerkUserID := claims.Subject
		if clerkUserID == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "token missing subject",
			})
		}

		// Lazy user sync: on first request we create the user record; subsequently we look them up.
		role := roleFromClaim(claims.Role)

		// Build placeholder email/name if the JWT template isn't configured yet.
		// These use the Clerk user ID so they're deterministic and unique.
		email := claims.Email
		if email == "" {
			email = fmt.Sprintf("%s@clerk.local", clerkUserID)
		}

		name := claims.Name
		if name == "" {
			name = "User"
		}

		var user models.User

		result := db.Where("clerk_id = ?", clerkUserID).First(&user)

		if result.Error != nil {
			if result.Error != gorm.ErrRecordNotFound {
				return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
					"error": "database error",
				})
			}

			user = models.User{
				ClerkID:     &clerkUserID,
				DisplayName: name,
				Email:       email,
				Role:        role,
			}
			if err := db.Create(&user).Error; err != nil {
				return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
					"error": "failed to create user record",
				})
			}

			// Set public_metadata.role = "user" in Clerk so future JWTs carry the role claim.
			// Only called when claims.Role == "" (no existing role in Clerk metadata).
			// Cannot overwrite "admin" or "manager" because those would already appear in the JWT.
			// Best-effort: failure is logged but doesn't block the user's first request.
			if claims.Role == "" {
				if err := setDefaultRoleInClerk(cfg.ClerkSecretKey, clerkUserID); err != nil {
					log.Printf("warning: could not set default role in Clerk for %s: %v", clerkUserID, err)
				}
			}
		} else {
			// User found — sync changed fields from the JWT in a single Updates() call.
			updates := map[string]any{}

			// Only sync role when the JWT explicitly carries one — avoids accidentally demoting
			// a user whose Clerk JWT template isn't configured yet (role would come as "").
			if claims.Role != "" && user.Role != role {
				updates["role"] = role
			}

			// Use claims.Name / claims.Email (raw JWT values) to avoid syncing placeholders
			// over real values already in the database.
			if claims.Name != "" && user.DisplayName != claims.Name {
				updates["display_name"] = claims.Name
			}
			if claims.Email != "" && user.Email != claims.Email {
				updates["email"] = claims.Email
			}

			if len(updates) > 0 {
				// Updates() with a map only touches the specified columns.
				db.Model(&user).Updates(updates)

				// Mirror changes in the in-memory struct so downstream handlers in this
				// request see fresh values without an extra DB round-trip.
				if r, ok := updates["role"].(models.UserRole); ok {
					user.Role = r
				}
				if n, ok := updates["display_name"].(string); ok {
					user.DisplayName = n
				}
				if e, ok := updates["email"].(string); ok {
					user.Email = e
				}
			}
		}

		// Store user info in request-scoped locals for downstream handlers.
		c.Locals("userID", user.ID.String())
		c.Locals("userRole", string(user.Role))

		return c.Next()
	}
}

// roleFromClaim converts the raw role string from the JWT into our typed UserRole enum.
// Unknown or empty values default to "user" (least privileged).
func roleFromClaim(s string) models.UserRole {
	switch s {
	case "admin":
		return models.UserRoleAdmin
	case "manager":
		return models.UserRoleManager
	default:
		return models.UserRoleUser
	}
}

// setDefaultRoleInClerk calls the Clerk Backend API to set public_metadata.role = "user"
// for a newly created user who doesn't yet have a role in Clerk metadata.
//
// Why this matters: the JWT template reads {{user.public_metadata.role}} to populate the
// "role" claim. Without it, the claim is empty and we can't distinguish roles on future sign-ins.
//
// Safety: only called when claims.Role == "" (no existing role in the JWT), so it cannot
// overwrite "admin" or "manager" — those would already appear in the token if set.
//
// Note: Clerk's PATCH /v1/users/{id} replaces the entire public_metadata object,
// so we only send {"role": "user"}. New users have no prior metadata to lose.
func setDefaultRoleInClerk(secretKey, clerkUserID string) error {
	body := strings.NewReader(`{"public_metadata": {"role": "user"}}`)

	url := fmt.Sprintf("https://api.clerk.com/v1/users/%s", clerkUserID)

	req, err := http.NewRequest(http.MethodPatch, url, body)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+secretKey)
	req.Header.Set("Content-Type", "application/json")

	// 5-second timeout — best-effort call on a hot path (user sign-in).
	client := &http.Client{Timeout: 5 * time.Second}

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("clerk API call: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		return fmt.Errorf("clerk API returned status %d", resp.StatusCode)
	}

	return nil
}
