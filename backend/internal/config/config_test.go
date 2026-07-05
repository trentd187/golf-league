// config_test.go covers configuration loading, focused on the Sentry release
// resolution that ties backend events to a deploy.
//
// Run:
//
//	go test ./internal/config/ -v
//
// Load() calls godotenv.Load(), which looks for a .env in the *current working
// directory* (internal/config/ during tests, where none exists), so it is a no-op
// here and t.Setenv fully controls the environment each case sees.
package config

import (
	"testing"
	"time"
)

// TestFirstNonEmpty covers the fallback-chain helper used by every config value
// that reads from more than one env var.
func TestFirstNonEmpty(t *testing.T) {
	cases := []struct {
		name   string
		values []string
		want   string
	}{
		{"first wins", []string{"a", "b"}, "a"},
		{"skips empty to second", []string{"", "b"}, "b"},
		{"skips multiple empties", []string{"", "", "c"}, "c"},
		{"all empty", []string{"", ""}, ""},
		{"no args", nil, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := firstNonEmpty(tc.values...); got != tc.want {
				t.Errorf("firstNonEmpty(%v) = %q, want %q", tc.values, got, tc.want)
			}
		})
	}
}

// TestLoad_SentryReleaseFallback is the regression guard for the audit finding:
// the Dockerfile never sets SENTRY_RELEASE, so without the RAILWAY_GIT_COMMIT_SHA
// fallback backend events shipped with an empty release.
func TestLoad_SentryReleaseFallback(t *testing.T) {
	t.Run("explicit SENTRY_RELEASE wins", func(t *testing.T) {
		t.Setenv("SENTRY_RELEASE", "explicit-sha")
		t.Setenv("RAILWAY_GIT_COMMIT_SHA", "railway-sha")
		if got := Load().SentryRelease; got != "explicit-sha" {
			t.Errorf("SentryRelease = %q, want explicit-sha", got)
		}
	})

	t.Run("falls back to RAILWAY_GIT_COMMIT_SHA", func(t *testing.T) {
		t.Setenv("SENTRY_RELEASE", "")
		t.Setenv("RAILWAY_GIT_COMMIT_SHA", "railway-sha")
		if got := Load().SentryRelease; got != "railway-sha" {
			t.Errorf("SentryRelease = %q, want railway-sha", got)
		}
	})

	t.Run("empty when neither set", func(t *testing.T) {
		t.Setenv("SENTRY_RELEASE", "")
		t.Setenv("RAILWAY_GIT_COMMIT_SHA", "")
		if got := Load().SentryRelease; got != "" {
			t.Errorf("SentryRelease = %q, want empty", got)
		}
	})
}

// TestLoad_PoolAndTimeoutDefaults guards the DB-pool + request-timeout defaults added for
// the availability hardening. The pool was previously unconfigured (Go's unlimited-open
// default), which let the backend exhaust Railway Postgres and wedge — these defaults bound
// and recycle it. An empty value resolves to the default (envInt reads "" as unset).
func TestLoad_PoolAndTimeoutDefaults(t *testing.T) {
	for _, k := range []string{
		"DB_MAX_OPEN_CONNS", "DB_MAX_IDLE_CONNS",
		"DB_CONN_MAX_LIFETIME_SEC", "DB_CONN_MAX_IDLE_TIME_SEC", "REQUEST_TIMEOUT_SEC",
	} {
		t.Setenv(k, "")
	}
	cfg := Load()
	if cfg.DBMaxOpenConns != 20 {
		t.Errorf("DBMaxOpenConns = %d, want 20", cfg.DBMaxOpenConns)
	}
	if cfg.DBMaxIdleConns != 10 {
		t.Errorf("DBMaxIdleConns = %d, want 10", cfg.DBMaxIdleConns)
	}
	if cfg.DBConnMaxLifetime != 300*time.Second {
		t.Errorf("DBConnMaxLifetime = %v, want 5m", cfg.DBConnMaxLifetime)
	}
	if cfg.DBConnMaxIdleTime != 300*time.Second {
		t.Errorf("DBConnMaxIdleTime = %v, want 5m", cfg.DBConnMaxIdleTime)
	}
	if cfg.RequestTimeout != 30*time.Second {
		t.Errorf("RequestTimeout = %v, want 30s", cfg.RequestTimeout)
	}
}

func TestLoad_PoolAndTimeoutOverrides(t *testing.T) {
	t.Setenv("DB_MAX_OPEN_CONNS", "50")
	t.Setenv("DB_CONN_MAX_LIFETIME_SEC", "120")
	t.Setenv("REQUEST_TIMEOUT_SEC", "15")

	cfg := Load()
	if cfg.DBMaxOpenConns != 50 {
		t.Errorf("DBMaxOpenConns = %d, want 50", cfg.DBMaxOpenConns)
	}
	if cfg.DBConnMaxLifetime != 120*time.Second {
		t.Errorf("DBConnMaxLifetime = %v, want 120s", cfg.DBConnMaxLifetime)
	}
	if cfg.RequestTimeout != 15*time.Second {
		t.Errorf("RequestTimeout = %v, want 15s", cfg.RequestTimeout)
	}
}

// TestLoad_UnparseablePoolValueFallsBackToDefault covers the envInt guard: a garbage value
// must not panic or zero the pool (0 = unlimited again) — it falls back to the default.
func TestLoad_UnparseablePoolValueFallsBackToDefault(t *testing.T) {
	t.Setenv("DB_MAX_OPEN_CONNS", "not-a-number")
	if got := Load().DBMaxOpenConns; got != 20 {
		t.Errorf("DBMaxOpenConns = %d, want 20 (fallback)", got)
	}
}
