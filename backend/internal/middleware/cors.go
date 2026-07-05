// Package middleware contains HTTP middleware functions for the Golf League API.
// This file configures Cross-Origin Resource Sharing for the web build.
package middleware

// cors.go — explicit CORS allow-list for the browser (web) client.
//
// The app ships a react-native-web build served from a different origin than the API, so
// every web request is subject to CORS. A browser sends a preflight OPTIONS before any
// request that carries a non-simple header and drops any header the response's
// Access-Control-Allow-Headers doesn't list. Fiber's bare cors.New() leaves AllowHeaders
// empty, which *reflects* the requested headers — so it happens to allow anything — but that
// is implicit and a future default change could silently start stripping Idempotency-Key
// (breaking the phantom-write dedupe for web saves) or sentry-trace/baggage (breaking web
// distributed tracing). We list the headers the client actually sends explicitly, and a test
// pins Idempotency-Key + the tracing pair so the guarantee can't regress unnoticed.
//
// AllowOrigins stays "*" (Fiber's default): the API authorizes with a bearer token in the
// Authorization header, not cookies, so no credentialed "*" restriction applies.

import (
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
)

// corsAllowHeaders is every request header the mobile/web client sends: bearer auth, JSON
// content type, the phantom-write Idempotency-Key, and Sentry's distributed-tracing pair.
// Keep it in sync with the client (utils/saveWithRetry.ts headers + the Sentry SDK).
const corsAllowHeaders = "Authorization,Content-Type,Idempotency-Key,sentry-trace,baggage"

// CORS returns the configured CORS middleware for the web client.
func CORS() fiber.Handler {
	return cors.New(cors.Config{
		AllowHeaders: corsAllowHeaders,
	})
}
