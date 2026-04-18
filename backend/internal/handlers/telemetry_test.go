// telemetry_test.go
// Unit tests for the PostMobileLogs handler in telemetry.go.
//
// Strategy: Tier 1 only — all tests exercise validation paths that return before
// any Loki push, using a fakePusher that records calls in memory.
//
// Run:
//
//	go test ./internal/handlers/ -run TestPostMobileLogs -v
package handlers_test

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/handlers"
)

// fakeLog records a single call to fakePusher.Log.
type fakeLog struct {
	level slog.Level
	msg   string
	args  []any
}

// fakePusher implements handlers.LokiPusher and records all Log calls.
// The mutex makes it safe even though tests run synchronously.
type fakePusher struct {
	mu   sync.Mutex
	logs []fakeLog
}

func (f *fakePusher) Log(_ context.Context, level slog.Level, msg string, args ...any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logs = append(f.logs, fakeLog{level: level, msg: msg, args: args})
}

func (f *fakePusher) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.logs)
}

// doTextBody fires a POST/PATCH with a plain-text body and application/json Content-Type
// set to a raw string — useful for testing JSON parse failures.
func doTextBody(t *testing.T, app interface {
	Test(*http.Request, ...int) (*http.Response, error)
}, method, path, rawBody string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(rawBody))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	return resp
}

// ─── PostMobileLogs ───────────────────────────────────────────────────────────

// TestPostMobileLogs_MissingBody verifies that a request with no body returns 400.
func TestPostMobileLogs_MissingBody(t *testing.T) {
	pusher := &fakePusher{}
	app := newSingleRouteApp(http.MethodPost, "/telemetry/logs", handlers.PostMobileLogs(pusher))

	req := httptest.NewRequest(http.MethodPost, "/telemetry/logs", nil)
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	assert.Equal(t, 0, pusher.callCount())
}

// TestPostMobileLogs_InvalidJSON verifies that malformed JSON returns 400.
func TestPostMobileLogs_InvalidJSON(t *testing.T) {
	pusher := &fakePusher{}
	app := newSingleRouteApp(http.MethodPost, "/telemetry/logs", handlers.PostMobileLogs(pusher))

	resp := doTextBody(t, app, http.MethodPost, "/telemetry/logs", "not-json")
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	assert.Equal(t, 0, pusher.callCount())
}

// TestPostMobileLogs_EmptyEntries verifies that an empty entries list returns 400.
func TestPostMobileLogs_EmptyEntries(t *testing.T) {
	pusher := &fakePusher{}
	app := newSingleRouteApp(http.MethodPost, "/telemetry/logs", handlers.PostMobileLogs(pusher))

	resp := doJSON(t, app, http.MethodPost, "/telemetry/logs", map[string]any{
		"entries": []any{},
	})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	assert.Equal(t, 0, pusher.callCount())
}

// TestPostMobileLogs_TooManyEntries verifies that > 100 entries returns 400.
func TestPostMobileLogs_TooManyEntries(t *testing.T) {
	pusher := &fakePusher{}
	app := newSingleRouteApp(http.MethodPost, "/telemetry/logs", handlers.PostMobileLogs(pusher))

	entries := make([]map[string]any, 101)
	for i := range entries {
		entries[i] = map[string]any{"event_type": "test", "message": "hi", "level": "info"}
	}
	resp := doJSON(t, app, http.MethodPost, "/telemetry/logs", map[string]any{
		"entries": entries,
	})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	assert.Equal(t, 0, pusher.callCount())
}

// TestPostMobileLogs_ValidRequest verifies that a valid 2-entry request returns 204
// and calls the pusher exactly twice.
func TestPostMobileLogs_ValidRequest(t *testing.T) {
	pusher := &fakePusher{}
	app := newSingleRouteApp(http.MethodPost, "/telemetry/logs", handlers.PostMobileLogs(pusher))

	resp := doJSON(t, app, http.MethodPost, "/telemetry/logs", map[string]any{
		"entries": []any{
			map[string]any{"event_type": "app.foregrounded", "message": "resumed", "level": "info"},
			map[string]any{"event_type": "score.submitted", "message": "score saved", "level": "info"},
		},
	})
	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, 2, pusher.callCount())
}

// TestPostMobileLogs_SkipsMalformedEntry verifies that entries with empty event_type
// are silently skipped and the request still returns 204.
func TestPostMobileLogs_SkipsMalformedEntry(t *testing.T) {
	pusher := &fakePusher{}
	app := newSingleRouteApp(http.MethodPost, "/telemetry/logs", handlers.PostMobileLogs(pusher))

	resp := doJSON(t, app, http.MethodPost, "/telemetry/logs", map[string]any{
		"entries": []any{
			map[string]any{"event_type": "", "message": "should be skipped", "level": "info"},
			map[string]any{"event_type": "valid.event", "message": "should be sent", "level": "info"},
		},
	})
	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, 1, pusher.callCount())
}

// TestPostMobileLogs_ValidTimestamp verifies that a well-formed RFC3339 timestamp
// is accepted and the request returns 204.
func TestPostMobileLogs_ValidTimestamp(t *testing.T) {
	pusher := &fakePusher{}
	app := newSingleRouteApp(http.MethodPost, "/telemetry/logs", handlers.PostMobileLogs(pusher))

	resp := doJSON(t, app, http.MethodPost, "/telemetry/logs", map[string]any{
		"entries": []any{
			map[string]any{
				"event_type": "app.foregrounded",
				"message":    "resumed",
				"level":      "info",
				"timestamp":  "2024-01-15T10:30:00Z",
			},
		},
	})
	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, 1, pusher.callCount())
}

// TestPostMobileLogs_LevelMapping verifies that debug/warn/error levels are
// forwarded to the pusher with the correct slog.Level values.
func TestPostMobileLogs_LevelMapping(t *testing.T) {
	pusher := &fakePusher{}
	app := newSingleRouteApp(http.MethodPost, "/telemetry/logs", handlers.PostMobileLogs(pusher))

	resp := doJSON(t, app, http.MethodPost, "/telemetry/logs", map[string]any{
		"entries": []any{
			map[string]any{"event_type": "a", "message": "m", "level": "debug"},
			map[string]any{"event_type": "b", "message": "m", "level": "warn"},
			map[string]any{"event_type": "c", "message": "m", "level": "error"},
			map[string]any{"event_type": "d", "message": "m", "level": "unknown"}, // → info
		},
	})
	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	require.Equal(t, 4, pusher.callCount())

	pusher.mu.Lock()
	defer pusher.mu.Unlock()
	assert.Equal(t, slog.LevelDebug, pusher.logs[0].level)
	assert.Equal(t, slog.LevelWarn, pusher.logs[1].level)
	assert.Equal(t, slog.LevelError, pusher.logs[2].level)
	assert.Equal(t, slog.LevelInfo, pusher.logs[3].level)
}
