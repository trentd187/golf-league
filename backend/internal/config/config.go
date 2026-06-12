// Package config handles loading and validating runtime configuration for the Golf League API.
// Values are read from environment variables following 12-factor app methodology —
// the same binary runs in dev, staging, and production by swapping env vars.
package config

import (
	"os"
	"strconv"

	// godotenv reads .env files in development; in production real env vars take precedence.
	"github.com/joho/godotenv"
)

// Config holds all runtime configuration values for the application.
type Config struct {
	Port             string // TCP port the HTTP server listens on (e.g. "8080")
	DatabaseURL      string // PostgreSQL connection string
	SupabaseJWKSURL  string // Supabase JWKS endpoint for RS256 JWT signature verification
	Env              string // Runtime environment: "development", "staging", or "production"
	GolfCourseAPIKey string // API key for GolfCourseAPI.com — enables external course search/import

	// Logging — structured slog output at or above this level (debug|info|warn|error, default: info)
	LogLevel string

	// Sentry — single full-stack observability vendor (errors, traces, logs).
	// Empty SentryDSN disables Sentry entirely: slog writes to stdout only and no
	// network call is made on startup. Lets local dev and CI run without credentials.
	SentryDSN              string
	SentryRelease          string  // typically the git SHA, set via Docker build arg
	SentryTracesSampleRate float64 // 0.0–1.0; default 0.1 in prod, 1.0 in dev
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

	// Default traces sample rate: 1.0 in dev (capture everything for local debugging),
	// 0.1 in prod (free-tier-friendly). Operator can override via SENTRY_TRACES_SAMPLE_RATE.
	tracesRate := 0.1
	if env == "development" {
		tracesRate = 1.0
	}
	if v := os.Getenv("SENTRY_TRACES_SAMPLE_RATE"); v != "" {
		if parsed, err := strconv.ParseFloat(v, 64); err == nil {
			tracesRate = parsed
		}
	}

	return &Config{
		Port:                   port,
		DatabaseURL:            os.Getenv("DATABASE_URL"),
		SupabaseJWKSURL:        os.Getenv("SUPABASE_JWKS_URL"),
		Env:                    env,
		GolfCourseAPIKey:       os.Getenv("GOLF_COURSE_API_KEY"),
		LogLevel:               logLevel,
		SentryDSN:              os.Getenv("SENTRY_DSN"),
		SentryRelease:          os.Getenv("SENTRY_RELEASE"),
		SentryTracesSampleRate: tracesRate,
	}
}
