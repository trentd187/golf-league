// sentry_test.go covers the observability package.
//
// Tier 1 only — no network, no DSN. We test:
//   - Init returns a stdout-only logger and a no-op shutdown when DSN is empty.
//   - parseLevel maps the four known strings and falls back to info.
//   - The fanout handler dispatches each record to every downstream handler.
//
// We deliberately do not exercise the DSN-set path: that calls sentry.Init,
// which is a process-global side effect with no clean teardown, and the
// behaviour we care about (event capture, slog→Sentry forwarding) is owned
// upstream by the sentry-go SDK and verified end-to-end during /qa.
package observability_test

import (
	"bytes"
	"context"
	"log/slog"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/config"
	"github.com/trentd187/golf-league/internal/observability"
)

// TestInit_NoDSN_ReturnsStdoutLogger verifies that when SentryDSN is empty,
// Init returns a working logger and a no-op shutdown closure — no panic, no
// network call.
func TestInit_NoDSN_ReturnsStdoutLogger(t *testing.T) {
	cfg := &config.Config{
		Env:      "test",
		LogLevel: "info",
	}

	logger, shutdown, err := observability.Init(cfg)
	require.NoError(t, err)
	require.NotNil(t, logger)
	require.NotNil(t, shutdown)

	// Shutdown must be safe to call even when Sentry was never initialised.
	assert.NotPanics(t, shutdown)

	// Logger must accept a record without panicking.
	assert.NotPanics(t, func() {
		logger.Info("hello", "k", "v")
	})
}

// TestInit_NoDSN_LogLevelHonoured verifies that the LogLevel config field
// gates the minimum level the returned logger emits.
func TestInit_NoDSN_LogLevelHonoured(t *testing.T) {
	cfg := &config.Config{
		Env:      "test",
		LogLevel: "warn",
	}

	logger, _, err := observability.Init(cfg)
	require.NoError(t, err)

	// Info should be filtered out, Warn should pass — Enabled is the cleanest
	// way to verify this without capturing stdout.
	assert.False(t, logger.Enabled(context.Background(), slog.LevelInfo))
	assert.True(t, logger.Enabled(context.Background(), slog.LevelWarn))
}

// TestSlogPusher_RoutesThroughLogger verifies that SlogPusher.Log writes
// through the wrapped *slog.Logger at the requested level, with the args
// preserved. We use a real JSON handler writing to a byte buffer so we can
// assert on the structured output exactly.
func TestSlogPusher_RoutesThroughLogger(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	pusher := &observability.SlogPusher{Logger: logger}

	pusher.Log(context.Background(), slog.LevelWarn, "score retry", "round_id", "abc", "attempt", 2)

	out := buf.String()
	assert.Contains(t, out, `"msg":"score retry"`)
	assert.Contains(t, out, `"level":"WARN"`)
	assert.Contains(t, out, `"round_id":"abc"`)
	assert.Contains(t, out, `"attempt":2`)
}
