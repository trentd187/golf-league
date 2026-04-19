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
	Port             string // TCP port the HTTP server listens on (e.g. "8080")
	DatabaseURL      string // PostgreSQL connection string
	ClerkSecretKey   string // Secret key for calling Clerk's Backend API
	ClerkJWKSURL     string // Clerk's JWKS URL — used to verify JWT signatures
	Env              string // Runtime environment: "development", "staging", or "production"
	GolfCourseAPIKey string // API key for GolfCourseAPI.com — enables external course search/import

	// Logging — structured slog output at or above this level (debug|info|warn|error, default: info)
	LogLevel string

	// Loki — all three must be set to enable remote log push; empty = stdout only
	LokiURL    string
	LokiUser   string
	LokiAPIKey string

	// OTLP — same gateway receives metrics (→ Mimir) and traces (→ Tempo); empty = disabled
	OTLPURL    string
	OTLPUser   string
	OTLPAPIKey string

	// Pyroscope — continuous profiling; empty = disabled
	PyroscopeURL    string
	PyroscopeUser   string
	PyroscopeAPIKey string
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

	logLevel := os.Getenv("LOG_LEVEL")
	if logLevel == "" {
		logLevel = "info"
	}

	return &Config{
		Port:             port,
		DatabaseURL:      os.Getenv("DATABASE_URL"),
		ClerkSecretKey:   os.Getenv("CLERK_SECRET_KEY"),
		ClerkJWKSURL:     os.Getenv("CLERK_JWKS_URL"),
		Env:              env,
		GolfCourseAPIKey: os.Getenv("GOLF_COURSE_API_KEY"),
		LogLevel:         logLevel,
		LokiURL:          os.Getenv("LOKI_URL"),
		LokiUser:         os.Getenv("LOKI_USER"),
		LokiAPIKey:       os.Getenv("LOKI_API_KEY"),
		OTLPURL:          os.Getenv("OTLP_URL"),
		OTLPUser:         os.Getenv("OTLP_USER"),
		OTLPAPIKey:       os.Getenv("OTLP_API_KEY"),
		PyroscopeURL:     os.Getenv("PYROSCOPE_URL"),
		PyroscopeUser:    os.Getenv("PYROSCOPE_USER"),
		PyroscopeAPIKey:  os.Getenv("PYROSCOPE_API_KEY"),
	}
}
