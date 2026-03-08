// Package config handles loading and validating runtime configuration for the Golf League API.
// Values are read from environment variables following 12-factor app methodology —
// the same binary runs in dev, staging, and production by swapping env vars.
package config

import (
	"os"

	// godotenv reads .env files in development; in production real env vars take precedence.
	"github.com/joho/godotenv"
)

// Config holds all runtime configuration values for the application.
type Config struct {
	Port           string // TCP port the HTTP server listens on (e.g. "8080")
	DatabaseURL    string // PostgreSQL connection string
	ClerkSecretKey string // Secret key for calling Clerk's Backend API
	ClerkJWKSURL   string // Clerk's JWKS URL — used to verify JWT signatures
	Env            string // Runtime environment: "development", "staging", or "production"
}

// Load reads configuration from environment variables and returns a populated Config.
// The _ discards the error from godotenv.Load — a missing .env file is fine in production.
func Load() *Config {
	_ = godotenv.Load()

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	env := os.Getenv("ENV")
	if env == "" {
		env = "development"
	}

	return &Config{
		Port:           port,
		DatabaseURL:    os.Getenv("DATABASE_URL"),
		ClerkSecretKey: os.Getenv("CLERK_SECRET_KEY"),
		ClerkJWKSURL:   os.Getenv("CLERK_JWKS_URL"),
		Env:            env,
	}
}
