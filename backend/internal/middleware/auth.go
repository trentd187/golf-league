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
	gofiberws "github.com/gofiber/contrib/websocket"
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
// claims. Shared by the header-based Auth middleware and the query-param WSAuth path
// (browsers cannot set an Authorization header on a WebSocket upgrade, so the token
// rides in ?token=). Any failure — bad signature/kid, expiry, malformed claims, or a
// missing subject — collapses to errInvalidToken (all are 401s to the caller).
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

		var user models.User
		result := db.Where("auth_id = ?", authID).First(&user)

		if result.Error != nil {
			if result.Error != gorm.ErrRecordNotFound {
				return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
					"error": "database error",
				})
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

// WSAuth returns a pre-upgrade middleware for the WebSocket route. WebSockets can't
// carry an Authorization header from a browser, so the JWT rides in the ?token= query
// param instead. This validates the token (no DB lookup — a live-score subscription is
// read-only, so any authenticated user may watch) and stores the auth subject in Locals
// for the connection handler. The JWKS keyfunc is fetched once at startup.
func WSAuth(cfg *config.Config) fiber.Handler {
	return MakeWSAuthHandler(newJWKSKeyfunc(cfg))
}

// MakeWSAuthHandler is the testable core of WSAuth. Exported so tests can supply a
// keyfunc (or nil for the pre-parse paths that reject before JWT parsing).
func MakeWSAuthHandler(keyfn jwt.Keyfunc) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Reject anything that isn't an actual WS upgrade so this route can't be hit
		// as a plain GET (which would hang waiting for an upgrade that never comes).
		if !gofiberws.IsWebSocketUpgrade(c) {
			return c.SendStatus(fiber.StatusUpgradeRequired) // 426
		}

		tokenStr := c.Query("token")
		if tokenStr == "" {
			logWSAuthFailed(c, "missing token")
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "missing token"})
		}

		claims, err := validateToken(tokenStr, keyfn)
		if err != nil {
			logWSAuthFailed(c, "invalid token")
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid token"})
		}

		// Subject is the Supabase user UUID — sufficient identity for a read-only
		// subscription and for the connection-lifecycle logs.
		c.Locals("userID", claims.Subject)
		return c.Next()
	}
}

// logWSAuthFailed records a rejected WebSocket upgrade. It's the first row of the WS
// observability matrix — a spike here means clients can't subscribe (expired tokens,
// a bad WS_URL, or an attack).
func logWSAuthFailed(c *fiber.Ctx, reason string) {
	slog.WarnContext(c.UserContext(), "WebSocket auth rejected",
		"event_type_label", "ws.auth_failed",
		"reason", reason,
		"path", c.Path())
}
