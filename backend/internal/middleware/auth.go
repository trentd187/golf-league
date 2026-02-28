// Package middleware contains HTTP middleware functions for the Golf League API.
// Middleware sits between the HTTP server and route handlers — it runs on every
// request that passes through it, making it the right place for cross-cutting
// concerns like authentication, logging, and rate limiting.
package middleware

import (
	"strings"

	// fiber is the HTTP framework; fiber.Handler is the function signature for middleware
	"github.com/gofiber/fiber/v2"
	// jwt is used to parse JSON Web Tokens (JWTs) from the Authorization header
	"github.com/golang-jwt/jwt/v5"
	"github.com/trentd187/golf-league/internal/config"
)

// Claims defines the data we expect to find inside a JWT.
// JWTs contain a payload (called "claims") — key/value data encoded in the token.
// jwt.RegisteredClaims provides standard fields like Subject (user ID), ExpiresAt, etc.
// We embed it and add our own "role" claim to track the user's permission level.
type Claims struct {
	jwt.RegisteredClaims        // Standard JWT fields (sub, exp, iat, etc.)
	Role                 string `json:"role"` // Custom claim: the user's role ("admin", "manager", "user")
}

// Auth returns a Fiber middleware handler that validates the JWT on incoming requests.
// It is a "closure" — a function that returns another function, capturing cfg in its scope.
// This pattern is used when middleware needs configuration at setup time.
//
// How JWT authentication works:
//  1. The client (mobile app) obtains a signed JWT from Clerk after sign-in
//  2. Every API request includes that JWT in the "Authorization: Bearer <token>" header
//  3. This middleware extracts the token, parses it, and puts the user's ID and role
//     into the request context (c.Locals) so handlers can read them
func Auth(cfg *config.Config) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Read the Authorization header value from the incoming HTTP request
		authHeader := c.Get("Authorization")

		// The header must exist and start with "Bearer " (the standard prefix for JWTs).
		// If either condition fails, reject the request immediately with HTTP 401 Unauthorized.
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "missing or invalid authorization header",
			})
		}

		// Strip the "Bearer " prefix to get just the raw token string
		tokenStr := strings.TrimPrefix(authHeader, "Bearer ")

		// TODO: replace with Clerk JWKS verification once Clerk is configured
		// ParseUnverified parses the JWT without checking the signature.
		// This is a temporary approach during development — in production the signature
		// MUST be verified against Clerk's public keys (JWKS) to prevent token forgery.
		// The &Claims{} argument tells the parser what struct to deserialize the payload into.
		token, _, err := jwt.NewParser().ParseUnverified(tokenStr, &Claims{})
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "invalid token",
			})
		}

		// Type-assert the parsed Claims from the interface{} type back to *Claims.
		// The "ok" boolean is false if the assertion fails (i.e., the token had unexpected structure).
		claims, ok := token.Claims.(*Claims)
		if !ok {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "invalid token claims",
			})
		}

		// Store the user's ID and role in the request context using c.Locals.
		// c.Locals is a key-value store scoped to a single request — downstream handlers
		// and middleware can read these values without re-parsing the token.
		// claims.Subject is the standard JWT "sub" field, which Clerk sets to the user's ID.
		c.Locals("userID", claims.Subject)
		c.Locals("userRole", claims.Role)

		// c.Next() passes control to the next middleware or route handler in the chain.
		// If we don't call this, the request stops here and no handler runs.
		return c.Next()
	}
}
