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

import "testing"

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
