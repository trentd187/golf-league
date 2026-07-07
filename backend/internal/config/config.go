// Package config handles loading and validating runtime configuration for the Golf League API.
// Values are read from environment variables following 12-factor app methodology —
// the same binary runs in dev, staging, and production by swapping env vars.
package config

import (
	"os"
	"strconv"
	"time"

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
	SentryRelease          string  // git SHA tying events to a deploy; SENTRY_RELEASE, else Railway's RAILWAY_GIT_COMMIT_SHA
	SentryTracesSampleRate float64 // 0.0–1.0; default 0.1 in prod, 1.0 in dev

	// Database connection pool. Previously UNSET — Go's database/sql then defaults to
	// UNLIMITED open connections with no lifetime, so under a live round (concurrent saves +
	// 60s polls) the backend could open more connections than Railway Postgres allows and
	// wedge: goroutines park waiting for a connection that can't be established (low CPU,
	// unresponsive — the 7/3 502 signature). Bounded + recycled here instead.
	DBMaxOpenConns    int
	DBMaxIdleConns    int
	DBConnMaxLifetime time.Duration
	DBConnMaxIdleTime time.Duration

	// RequestTimeout bounds each /api/v1 request's context so a hung DB query fails fast
	// (a logged 5xx that reaches Sentry) instead of parking a goroutine into a silent 502.
	RequestTimeout time.Duration
}

// envInt reads an int env var, falling back to def when unset or unparseable.
func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil {
			return parsed
		}
	}
	return def
}

// envDurationSec reads an integer-seconds env var into a time.Duration, falling back to
// defSec seconds when unset or unparseable.
func envDurationSec(key string, defSec int) time.Duration {
	return time.Duration(envInt(key, defSec)) * time.Second
}

// firstNonEmpty returns the first argument that is not the empty string, or "" if
// all are empty. Used so a config value can fall back through a chain of env vars.
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
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

	// Release tag for Sentry. Prefer an explicit SENTRY_RELEASE; otherwise fall back to
	// RAILWAY_GIT_COMMIT_SHA, which Railway injects automatically on every deploy. Without
	// this fallback the Dockerfile sets no SENTRY_RELEASE, so backend events shipped with an
	// empty release — no release-health or regression-by-deploy. Empty is still valid (local dev).
	sentryRelease := firstNonEmpty(os.Getenv("SENTRY_RELEASE"), os.Getenv("RAILWAY_GIT_COMMIT_SHA"))

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
		SentryRelease:          sentryRelease,
		SentryTracesSampleRate: tracesRate,

		// Pool defaults: conservative for a single Railway replica, well under Postgres's
		// connection cap, with a 5-minute lifetime so a Railway-proxy-dropped connection is
		// recycled rather than handed to a request that then hangs on it.
		DBMaxOpenConns:    envInt("DB_MAX_OPEN_CONNS", 20),
		DBMaxIdleConns:    envInt("DB_MAX_IDLE_CONNS", 10),
		DBConnMaxLifetime: envDurationSec("DB_CONN_MAX_LIFETIME_SEC", 300),
		DBConnMaxIdleTime: envDurationSec("DB_CONN_MAX_IDLE_TIME_SEC", 300),
		RequestTimeout:    envDurationSec("REQUEST_TIMEOUT_SEC", 30),
	}
}
