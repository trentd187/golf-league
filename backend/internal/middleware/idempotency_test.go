// Package middleware_test covers Idempotency-Key replay detection. Tier 1 — no DB
// or network. The store's clock is injected so TTL expiry is tested without sleeping.
package middleware_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/trentd187/golf-league/internal/middleware"
)

func TestIdempotencyStore_FirstObserveIsNotReplay(t *testing.T) {
	s := middleware.NewIdempotencyStore()
	assert.False(t, s.Observe("k1"), "first sighting of a key is never a replay")
}

func TestIdempotencyStore_SecondObserveIsReplay(t *testing.T) {
	s := middleware.NewIdempotencyStore()
	s.Observe("k1")
	assert.True(t, s.Observe("k1"), "a repeated key within the TTL is a replay")
}

func TestIdempotencyStore_DistinctKeysAreIndependent(t *testing.T) {
	s := middleware.NewIdempotencyStore()
	s.Observe("k1")
	assert.False(t, s.Observe("k2"), "a different key is not a replay")
}

func TestIdempotencyStore_ExpiredKeyIsNotReplay(t *testing.T) {
	// Drive a fake clock so a key observed "11 minutes ago" has expired (TTL is 10m).
	clock := time.Unix(0, 0)
	s := middleware.NewIdempotencyStore()
	s.SetClockForTest(func() time.Time { return clock })

	s.Observe("k1")
	clock = clock.Add(11 * time.Minute)
	assert.False(t, s.Observe("k1"), "a key past the TTL is treated as unseen")
}

// makeReplayApp wires the replay-logging middleware ahead of a 200 handler, sharing
// one store so repeated requests can be detected across calls.
func makeReplayApp(store *middleware.IdempotencyStore) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(middleware.IdempotencyReplayLog(store))
	app.Put("/scores", func(c *fiber.Ctx) error { return c.SendStatus(fiber.StatusOK) })
	return app
}

func doPut(t *testing.T, app *fiber.App, key string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, "/scores", nil)
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	return resp
}

func TestIdempotencyReplayLog_LogsOnlyOnReplay(t *testing.T) {
	buf := captureLogs(t) // shared helper from errorlog_test.go
	store := middleware.NewIdempotencyStore()
	app := makeReplayApp(store)

	// First request with the key: passes through, no replay log.
	resp := doPut(t, app, "key-abc")
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Empty(t, buf.Bytes(), "first request must not log a replay")

	// Second request with the SAME key: the replay signal fires.
	doPut(t, app, "key-abc")
	var rec map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &rec))
	assert.Equal(t, "score.idempotent_replay", rec["event_type_label"])
	assert.Equal(t, "key-abc", rec["idempotency_key"])
	assert.Equal(t, "/scores", rec["path"])
}

func TestIdempotencyReplayLog_NoHeaderNeverLogs(t *testing.T) {
	buf := captureLogs(t)
	store := middleware.NewIdempotencyStore()
	app := makeReplayApp(store)

	// Two requests with no Idempotency-Key (e.g. an older client) — never a replay.
	doPut(t, app, "")
	doPut(t, app, "")
	assert.Empty(t, buf.Bytes(), "requests without the header must not log")
}
