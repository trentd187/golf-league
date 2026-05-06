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
	// Supabase uses RS256 (asymmetric); keyfunc handles the JWKS endpoint automatically.
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
	return MakeAuthHandler(jwks.Keyfunc, db)
}

// MakeAuthHandler returns the auth handler closure using a jwt.Keyfunc and DB.
// Exported so that tests can supply a custom keyfunc (or nil for paths that
// return 401 before JWT parsing) and a nil DB for paths that return before any
// DB access is attempted.
func MakeAuthHandler(keyfn jwt.Keyfunc, db *gorm.DB) fiber.Handler {
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
		token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, keyfn)
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
		// full_name and avatar_url are set by Google OAuth; custom_avatar_url is set
		// only by the mobile app's profile upload flow.
		// On Google re-login, Supabase overwrites avatar_url with the Google profile
		// picture, which would stomp user-uploaded photos. custom_avatar_url is never
		// touched by OAuth, so we prefer it when syncing to our DB.
		fullName, _ := claims.UserMetadata["full_name"].(string)
		avatarURL, _ := claims.UserMetadata["avatar_url"].(string)
		if custom, _ := claims.UserMetadata["custom_avatar_url"].(string); custom != "" {
			avatarURL = custom
		}

		var user models.User
		result := db.Where("auth_id = ?", authID).First(&user)

		if result.Error != nil {
			if result.Error != gorm.ErrRecordNotFound {
				c.Locals("error_detail", "auth.db_error: "+result.Error.Error())
				return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
					"error": "database error",
				})
			}

			// auth_id not found — check if a row already exists for this email.
			// This fallback handles the Clerk→Supabase auth migration: the same user has a new
			// Supabase UUID but the same email. Rather than inserting a duplicate row (which would
			// violate the UNIQUE constraint on email), we adopt the existing row by writing the
			// new auth_id.
			// TODO: remove this fallback once all production users have re-authenticated via
			// Supabase and no Clerk UUIDs remain in the auth_id column.
			if email != "" {
				var existing models.User
				emailResult := db.Where("email = ?", email).First(&existing)
				if emailResult.Error == nil {
					// Existing row found — migrate it to the new Supabase auth_id.
					migrationUpdates := map[string]interface{}{"auth_id": authID}
					if avatarURL != "" {
						migrationUpdates["avatar_url"] = avatarURL
					}
					if err := db.Model(&existing).Updates(migrationUpdates).Error; err != nil {
						c.Locals("error_detail", "auth.migrate_auth_id: "+err.Error())
						return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
							"error": "failed to migrate user auth_id",
						})
					}
					existing.AuthID = &authID
					if avatarURL != "" {
						existing.AvatarURL = &avatarURL
					}
					user = existing
					// Skip the create block below.
					goto userResolved
				} else if emailResult.Error != gorm.ErrRecordNotFound {
					c.Locals("error_detail", "auth.email_lookup: "+emailResult.Error.Error())
					return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
						"error": "database error",
					})
				}
			}

			// Truly new user — create the record. Role defaults to "user".
			// Try to get the display name from OAuth user_metadata (e.g. Google sets full_name).
			{
				displayName := "User"
				if name, ok := claims.UserMetadata["full_name"].(string); ok && name != "" {
					displayName = name
				} else if email != "" {
					if idx := strings.Index(email, "@"); idx > 0 {
						displayName = email[:idx]
					}
				}
				var avatarURLPtr *string
				if avatarURL != "" {
					avatarURLPtr = &avatarURL
				}
				user = models.User{
					AuthID:      &authID,
					DisplayName: displayName,
					Email:       email,
					AvatarURL:   avatarURLPtr,
					Role:        models.UserRoleUser,
				}
				if err := db.Create(&user).Error; err != nil {
					c.Locals("error_detail", "auth.create_user: "+err.Error())
					return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
						"error": "failed to create user record",
					})
				}
			}
		} else {
			// User found by auth_id — sync fields that may have changed.
			updates := map[string]interface{}{}
			if email != "" && user.Email != email {
				updates["email"] = email
				user.Email = email
			}
			if fullName != "" && user.DisplayName != fullName {
				updates["display_name"] = fullName
				user.DisplayName = fullName
			}
			if avatarURL != "" && (user.AvatarURL == nil || *user.AvatarURL != avatarURL) {
				updates["avatar_url"] = avatarURL
				user.AvatarURL = &avatarURL
			}
			if len(updates) > 0 {
				db.Model(&user).Updates(updates)
			}
		}

	userResolved:

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
