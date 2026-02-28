// Package config handles loading and validating runtime configuration for the Golf League API.
// Configuration values (like the database URL and API port) are read from environment variables
// rather than being hardcoded. This follows the "12-factor app" methodology, which recommends
// storing config in the environment so the same binary can run in dev, staging, and production
// without changing any code — just swap the environment variables.
package config

import (
	"os"

	// godotenv reads a .env file and loads its key=value pairs into the process environment.
	// This is convenient in development: create a .env file with your secrets and they're
	// automatically available as environment variables. In production, real env vars are used instead.
	"github.com/joho/godotenv"
)

// Config holds all runtime configuration values for the application.
// Using a struct groups related settings together and makes them easy to pass around.
type Config struct {
	Port           string // The TCP port the HTTP server will listen on (e.g., "8080")
	DatabaseURL    string // PostgreSQL connection string (e.g., "postgres://user:pass@host/dbname")
	ClerkSecretKey string // Secret key for verifying Clerk authentication tokens server-side
	Env            string // The runtime environment: "development", "staging", or "production"
}

// Load reads configuration from environment variables and returns a populated Config.
// It first tries to load a .env file for local development. The underscore (_) discards
// the error from godotenv.Load — if there's no .env file (e.g., in production), that's fine.
func Load() *Config {
	// Attempt to load a .env file from the current working directory.
	// The error is intentionally ignored: missing .env is acceptable in production
	// because real environment variables will already be set by the deployment platform.
	_ = godotenv.Load()

	// os.Getenv returns the value of an environment variable, or "" if it isn't set.
	// We provide sensible defaults for optional settings like PORT and ENV.
	port := os.Getenv("PORT")
	if port == "" {
		// Default to port 8080 if none is specified — the standard for HTTP dev servers
		port = "8080"
	}

	env := os.Getenv("ENV")
	if env == "" {
		// Default to "development" so local runs don't accidentally behave like production
		env = "development"
	}

	// Return a pointer to a Config struct populated with all values.
	// Using a pointer (*Config) avoids copying the struct everywhere it's passed.
	return &Config{
		Port:           port,
		DatabaseURL:    os.Getenv("DATABASE_URL"),    // Required — server will fail to start without it
		ClerkSecretKey: os.Getenv("CLERK_SECRET_KEY"), // Required for JWT verification once Clerk is configured
		Env:            env,
	}
}
