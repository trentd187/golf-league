// Package middleware contains HTTP middleware functions for the Golf League API.
// Middleware runs on every request before route handlers — the right place for
// cross-cutting concerns like authentication and role checking.
package middleware

import (
	"log"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	// keyfunc fetches Supabase's public JWKS keys, caches them, and handles key rotation.
	// Supabase uses RS256 (asymmetric) by default — same JWKS-based flow as Clerk.
	"github.com/MicahParks/keyfunc/v3"
	"github.com/trentd187/golf-league/internal/config"
	"github.com/trentd187/golf-league/internal/models"

	"gorm.io/gorm"
)

// Claims defines the data we expect inside a Supabase JWT payload.
// Standard fields (Subject = Supabase user UUID, expiry, etc.) come from jwt.RegisteredClaims.
// Role is NOT embedded in the JWT — it lives only in our PostgreSQL users.role column.
// UserMetadata is populated by OAuth providers (e.g. Google sets full_name, avatar_url).
type Claims struct {
	jwt.RegisteredClaims
	Email        string                 `json:"email"`
	UserMetadata map[string]interface{} `json:"user_metadata"`
}

// bearerPrefix is the standard HTTP Authorization header prefix for JWTs.
const bearerPrefix = "Bearer "

// Auth returns a Fiber middleware handler that:
//  1. Validates the JWT from the "Authorization: Bearer <token>" header.
//  2. Finds the matching user in our database (or creates one on first visit).
//  3. Syncs the user's email from the JWT into the database.
//  4. Stores the user's internal UUID and role in c.Locals for downstream handlers.
//
// The JWKS key function is initialized once here (at server startup) via a closure
// and reused on every request, avoiding repeated network calls to Supabase.
func Auth(cfg *config.Config, db *gorm.DB) fiber.Handler {
	// Fetch Supabase's JWKS at startup and cache it. keyfunc handles automatic key rotation.
	// Without the JWKS we cannot verify any token — fatal at startup, not silently at request time.
	jwks, err := keyfunc.NewDefault([]string{cfg.SupabaseJWKSURL})
	if err != nil {
		log.Fatalf("Failed to load Supabase JWKS — is SUPABASE_JWKS_URL set? %v", err)
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
		// Supabase's private key.
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

		// claims.Subject is the standard JWT "sub" field — Supabase sets it to the user's UUID.
		authID := claims.Subject
		if authID == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "token missing subject",
			})
		}

		email := claims.Email

		var user models.User
		result := db.Where("auth_id = ?", authID).First(&user)

		if result.Error != nil {
			if result.Error != gorm.ErrRecordNotFound {
				return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
					"error": "database error",
				})
			}

			// First visit: create the user record. Role defaults to "user".
			// Try to get the display name from OAuth user_metadata (e.g. Google sets full_name).
			displayName := "User"
			if name, ok := claims.UserMetadata["full_name"].(string); ok && name != "" {
				displayName = name
			} else if email != "" {
				// Fall back to the part of the email before the @ symbol.
				if idx := strings.Index(email, "@"); idx > 0 {
					displayName = email[:idx]
				}
			}
			user = models.User{
				AuthID:      &authID,
				DisplayName: displayName,
				Email:       email,
				Role:        models.UserRoleUser,
			}
			if err := db.Create(&user).Error; err != nil {
				return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
					"error": "failed to create user record",
				})
			}
		} else {
			// User found — sync email if it changed (role is managed only via DB, never from JWT).
			if email != "" && user.Email != email {
				db.Model(&user).Update("email", email)
				user.Email = email
			}
		}

		// Store user info in request-scoped locals for downstream handlers.
		c.Locals("userID", user.ID.String())
		c.Locals("userRole", string(user.Role))

		// Tag the active OTel span with the user's database UUID so traces in
		// Grafana Tempo can be filtered by user when investigating reported issues.
		trace.SpanFromContext(c.UserContext()).SetAttributes(
			attribute.String("user.id", user.ID.String()),
		)

		return c.Next()
	}
}
