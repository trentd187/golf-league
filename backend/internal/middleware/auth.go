// Package middleware contains HTTP middleware functions for the Golf League API.
// Middleware sits between the HTTP server and route handlers — it runs on every
// request that passes through it, making it the right place for cross-cutting
// concerns like authentication, logging, and rate limiting.
package middleware

import (
	"fmt"
	"strings"

	// fiber is the HTTP framework; fiber.Handler is the function signature for middleware
	"github.com/gofiber/fiber/v2"
	// jwt is used to parse JSON Web Tokens (JWTs) from the Authorization header
	"github.com/golang-jwt/jwt/v5"
	"github.com/trentd187/golf-league/internal/config"
	"github.com/trentd187/golf-league/internal/models"
	// gorm is our ORM — used here to find or create the user record in Postgres
	"gorm.io/gorm"
)

// Claims defines the data we expect inside a Clerk JWT payload.
// Clerk's default token includes standard fields (Subject = Clerk user ID, expiry, etc.).
// We also read custom claims that you add via the Clerk dashboard JWT template:
//
//   "role":  "{{user.public_metadata.role}}"   — the user's permission level
//   "email": "{{user.primary_email_address}}"  — used to populate our users table
//   "name":  "{{user.full_name}}"              — display name for our users table
//
// Without these custom claims in the template, role will be empty (defaults to "user")
// and email/name will use placeholder values.
type Claims struct {
	jwt.RegisteredClaims        // Standard JWT fields: Subject (user ID), ExpiresAt, IssuedAt, etc.
	Role                 string `json:"role"`  // Custom claim: "admin", "manager", or "user"
	Email                string `json:"email"` // Custom claim: the user's primary email address
	Name                 string `json:"name"`  // Custom claim: the user's full name
}

// Auth returns a Fiber middleware handler that:
//  1. Validates the JWT from the "Authorization: Bearer <token>" header
//  2. Finds the matching user in our database (or creates one on first visit)
//  3. Syncs the user's role from the JWT into the database
//  4. Stores the user's internal UUID and role in the request context (c.Locals)
//     so downstream handlers can read them without re-parsing the token
//
// This is a closure — a function that returns another function, capturing cfg and db
// in its scope so they're available every time a request comes in.
func Auth(cfg *config.Config, db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// --- Step 1: Extract the token from the Authorization header ---

		authHeader := c.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "missing or invalid authorization header",
			})
		}

		// Strip the "Bearer " prefix to get just the raw JWT string
		tokenStr := strings.TrimPrefix(authHeader, "Bearer ")

		// --- Step 2: Parse the JWT ---
		// TODO: replace ParseUnverified with full JWKS signature verification.
		// ParseUnverified skips signature checking — fine for development but
		// MUST be replaced before production. Verification prevents token forgery.
		token, _, err := jwt.NewParser().ParseUnverified(tokenStr, &Claims{})
		if err != nil {
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

		// claims.Subject is the standard JWT "sub" field — Clerk sets it to the Clerk user ID
		clerkUserID := claims.Subject
		if clerkUserID == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "token missing subject",
			})
		}

		// --- Step 3: Find or create the user in our database ---
		// This is "lazy user sync": the first time a user hits any authenticated endpoint,
		// we create their record in our database. On subsequent requests we just look them up.

		// Determine the role from the JWT claim, defaulting to "user" if not set
		// (e.g. if the Clerk JWT template hasn't been configured yet)
		role := roleFromClaim(claims.Role)

		// Build placeholder email and name in case the JWT template doesn't include them.
		// These use the Clerk user ID so they're deterministic and unique.
		// They should be replaced by the real values once the JWT template is set up.
		email := claims.Email
		if email == "" {
			// Placeholder: "user_2abc123@clerk.local" — clearly not real, and unique per user
			email = fmt.Sprintf("%s@clerk.local", clerkUserID)
		}

		name := claims.Name
		if name == "" {
			name = "User" // Generic fallback display name
		}

		var user models.User

		// Try to find an existing user by their Clerk ID
		result := db.Where("clerk_id = ?", clerkUserID).First(&user)

		if result.Error != nil {
			// User not found — create a new record for them
			// gorm.ErrRecordNotFound is the expected "not found" error; anything else is a DB problem
			if result.Error != gorm.ErrRecordNotFound {
				return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
					"error": "database error",
				})
			}

			// Create the user row — GORM will call INSERT and populate user.ID with the new UUID
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
		} else {
			// User found — sync their role in case it changed in Clerk
			// (e.g. admin changed someone's role via the Clerk dashboard)
			if user.Role != role && claims.Role != "" {
				db.Model(&user).Update("role", role)
				user.Role = role
			}
		}

		// --- Step 4: Store user info in the request context ---
		// c.Locals is a key-value store scoped to this single request.
		// Handlers read "userID" (our internal UUID) and "userRole" from here.
		c.Locals("userID", user.ID.String())
		c.Locals("userRole", string(user.Role))

		// Pass control to the next middleware or route handler
		return c.Next()
	}
}

// roleFromClaim converts the raw role string from the JWT into our typed UserRole enum.
// If the claim is missing or unrecognised, it defaults to "user" (least privileged).
func roleFromClaim(s string) models.UserRole {
	switch s {
	case "admin":
		return models.UserRoleAdmin
	case "manager":
		return models.UserRoleManager
	default:
		// Unknown or empty role — default to regular user
		return models.UserRoleUser
	}
}
