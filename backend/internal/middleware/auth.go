// Package middleware contains HTTP middleware functions for the Golf League API.
// Middleware runs on every request before route handlers — the right place for
// cross-cutting concerns like authentication and role checking.
package middleware

import (
	"context"
	"errors"
	"log"
	"log/slog"
	"strings"
	"time"

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

// jwksHTTPTimeout bounds the JWKS fetch. The library's default is a full MINUTE, which would
// stall startup (and every background refresh) far longer than is useful.
const jwksHTTPTimeout = 10 * time.Second

// jwksRefreshInterval is how often the key set is re-fetched in the background. Shorter than
// the library's 1-hour default so a rotated Supabase key is picked up promptly.
const jwksRefreshInterval = 15 * time.Minute

// newJWKSKeyfunc fetches Supabase's JWKS at startup and returns the verifying key function
// (keyfunc handles caching + automatic key rotation). Without the JWKS we cannot verify any
// token, so a failure here is fatal at startup — and, as of this change, ACTUALLY is.
//
// The bug this fixes. keyfunc.NewDefault builds its storage with
// jwkset.HTTPClientStorageOptions{NoErrorReturnFirstHTTPReq: true} (jwkset/http.go), and
// jwkset/storage.go then does `return s, nil` when the first fetch fails. So NewDefault NEVER
// returned an error for an unreachable JWKS — the log.Fatalf below was dead code, and the old
// comment claiming "a failure here is fatal at startup" asserted the exact opposite of the
// truth.
//
// What actually happened: the server booted with an EMPTY key set, every authenticated request
// failed validateToken and got a 401, and /health (which only pinged the DB) kept answering
// 200 — so Railway happily routed traffic into a service where nothing worked, indefinitely.
// A silent, total auth outage that looked healthy.
//
// NoErrorReturnFirstHTTPReq: false makes the fatal real: fail fast, let Railway restart, and
// never serve a broken key set. RefreshErrorHandler covers the other half — a JWKS that goes
// away AFTER a good boot, which no startup check can catch.
// LoadJWKS fetches the key set and returns the verifying key function. Exported (and
// error-returning rather than fatal) so a test can assert the contract that actually matters:
// an UNREACHABLE JWKS MUST RETURN AN ERROR. Under keyfunc.NewDefault it did not — that is the
// whole bug.
func LoadJWKS(ctx context.Context, jwksURL string) (jwt.Keyfunc, error) {
	noErrorReturnFirstHTTPReq := false

	jwks, err := keyfunc.NewDefaultOverrideCtx(ctx,
		[]string{jwksURL},
		keyfunc.Override{
			HTTPTimeout:               jwksHTTPTimeout,
			NoErrorReturnFirstHTTPReq: &noErrorReturnFirstHTTPReq,
			RefreshInterval:           jwksRefreshInterval,
			RefreshErrorHandlerFunc: func(u string) func(ctx context.Context, err error) {
				return func(ctx context.Context, err error) {
					// A background refresh failed. The cached keys still work, so this is not
					// fatal — but if it keeps failing through a key rotation, every token
					// starts failing to verify. Give it a stable label so it is alertable.
					slog.ErrorContext(ctx, "failed to refresh Supabase JWKS",
						"event_type_label", "auth.jwks_refresh_failed",
						"jwks_url", u,
						"error", err.Error(),
					)
				}
			},
		},
	)
	if err != nil {
		return nil, err
	}

	jwksStore = jwks
	return jwks.Keyfunc, nil
}

// newJWKSKeyfunc loads the key set at startup, or dies trying. Called once, from Auth.
func newJWKSKeyfunc(cfg *config.Config) jwt.Keyfunc {
	keyfn, err := LoadJWKS(context.Background(), cfg.SupabaseJWKSURL)
	if err != nil {
		log.Fatalf("Failed to load Supabase JWKS — is SUPABASE_JWKS_URL set? %v", err)
	}
	return keyfn
}

// jwksStore holds the live key set so /health can report whether we actually have keys.
// A server with zero keys 401s every request; without this, that outage is invisible to
// any readiness check.
var jwksStore keyfunc.Keyfunc

// JWKSKeyCount returns how many JWKs are currently cached, and whether the key set has been
// initialised at all. handlers.HealthCheck uses it: zero keys means every authenticated
// request will 401, which must not be reported as healthy.
func JWKSKeyCount(ctx context.Context) (count int, ok bool) {
	if jwksStore == nil {
		return 0, false
	}
	jwkSet, err := jwksStore.Storage().KeyReadAll(ctx)
	if err != nil {
		return 0, false
	}
	return len(jwkSet), true
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
