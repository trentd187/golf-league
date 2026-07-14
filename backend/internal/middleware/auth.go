// Package middleware contains HTTP middleware functions for the Golf League API.
// Middleware runs on every request before route handlers — the right place for
// cross-cutting concerns like authentication and role checking.
package middleware

import (
	"errors"
	"log"
	"log/slog"
	"strings"

	"github.com/getsentry/sentry-go"
	sentryfiber "github.com/getsentry/sentry-go/fiber"
	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"

	// keyfunc fetches Supabase's public JWKS keys, caches them, and handles key rotation.
	// Supabase uses RS256 (asymmetric); keyfunc handles the JWKS endpoint automatically.
	"github.com/MicahParks/keyfunc/v3"
	"github.com/trentd187/golf-league/internal/config"
	"github.com/trentd187/golf-league/internal/models"

	"gorm.io/gorm"
)

// errInvalidToken is the single error returned by validateToken for any rejection
// (bad signature, expired, malformed claims, missing subject). All map to 401, so
// callers don't need to distinguish — they just deny.
var errInvalidToken = errors.New("invalid token")

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

// authDBError returns a 500 for a database failure inside the auth middleware, stashing the
// cause in c.Locals("error_detail") the way the handlers' write<Domain>Error helpers do.
//
// The two 500s here used to be built inline with no detail, so ErrorLogger emitted an
// http.error event with an EMPTY "error" field — a 500 on user provisioning (a user's very
// first sign-in) reached Sentry with the root cause thrown away.
func authDBError(c *fiber.Ctx, tag string, err error, msg string) error {
	c.Locals("error_detail", tag+": "+err.Error())
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": msg})
}

// newJWKSKeyfunc fetches Supabase's JWKS at startup and returns the verifying
// key function (keyfunc handles caching + automatic key rotation). Without the
// JWKS we cannot verify any token, so a failure here is fatal at startup rather
// than a silent per-request failure later.
func newJWKSKeyfunc(cfg *config.Config) jwt.Keyfunc {
	jwks, err := keyfunc.NewDefault([]string{cfg.SupabaseJWKSURL})
	if err != nil {
		log.Fatalf("Failed to load Supabase JWKS — is SUPABASE_JWKS_URL set? %v", err)
	}
	return jwks.Keyfunc
}

// validateToken parses and cryptographically verifies a Supabase JWT, returning its
// claims. Any failure — bad signature/kid, expiry, malformed claims, or a missing
// subject — collapses to errInvalidToken (all are 401s to the caller).
func validateToken(tokenStr string, keyfn jwt.Keyfunc) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, keyfn)
	if err != nil || !token.Valid {
		return nil, errInvalidToken
	}
	claims, ok := token.Claims.(*Claims)
	if !ok || claims.Subject == "" {
		return nil, errInvalidToken
	}
	return claims, nil
}

// Auth returns a Fiber middleware handler that:
//  1. Validates the JWT from the "Authorization: Bearer <token>" header.
//  2. Finds the matching user in our database (or creates one on first visit).
//  3. Syncs the user's email from the JWT into the database.
//  4. Stores the user's internal UUID and role in c.Locals for downstream handlers.
//
// The JWKS key function is initialized once here (at server startup) via a closure
// and reused on every request, avoiding repeated network calls to Supabase.
func Auth(cfg *config.Config, db *gorm.DB) fiber.Handler {
	return MakeAuthHandler(newJWKSKeyfunc(cfg), db)
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

		// validateToken verifies the cryptographic signature, the key ID (kid), and the
		// expiry claim, and guarantees a non-empty subject. An attacker cannot forge a
		// valid signature without Supabase's private key.
		claims, err := validateToken(tokenStr, keyfn)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "invalid token",
			})
		}

		// claims.Subject is the standard JWT "sub" field — Supabase sets it to the user's UUID.
		authID := claims.Subject

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

		// WithContext is not optional here: this middleware runs on EVERY authenticated
		// request, and without it these queries ignore RequestTimeout — so a hung DB parks the
		// goroutine indefinitely, which is the exact failure the timeout middleware exists to
		// prevent. Every other DB call in the codebase already passes the context.
		ctx := c.UserContext()

		var user models.User
		result := db.WithContext(ctx).Where("auth_id = ?", authID).First(&user)

		if result.Error != nil {
			// errors.Is, not !=: a wrapped ErrRecordNotFound would otherwise be treated as a
			// hard DB failure and 500 on every first-time sign-in.
			if !errors.Is(result.Error, gorm.ErrRecordNotFound) {
				return authDBError(c, "auth.lookup_user", result.Error, "database error")
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
				if err := db.WithContext(ctx).Create(&user).Error; err != nil {
					return authDBError(c, "auth.create_user", err, "failed to create user record")
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
				// The error used to be discarded. This is the write that keeps the display
				// name, email, and avatar in sync — if it fails it fails on every request,
				// forever, with no log and no Sentry event, and the user's name silently
				// never persists. It is not worth 500ing the whole request over (the caller
				// is authenticated and their data is merely stale), but it must be SEEN.
				if err := db.WithContext(ctx).Model(&user).Updates(updates).Error; err != nil {
					slog.WarnContext(ctx, "failed to sync user fields from JWT",
						"event_type_label", "auth.user_sync_failed",
						"user_id", user.ID.String(),
						"error", err.Error(),
					)
				}
			}
		}

		// Store user info in request-scoped locals for downstream handlers.
		c.Locals("userID", user.ID.String())
		c.Locals("userRole", string(user.Role))

		// Attach the user to this request's Sentry scope so events and traces
		// captured downstream are filterable by user in the Sentry UI.
		if hub := sentryfiber.GetHubFromContext(c); hub != nil {
			hub.Scope().SetUser(sentry.User{
				ID:    user.ID.String(),
				Email: user.Email,
			})
		}

		return c.Next()
	}
}
