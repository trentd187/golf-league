// Package middleware_test covers the per-request access-logging middleware. Tier 1 — no
// DB or network. Like errorlog_test, it swaps the process slog default for a buffer-backed
// JSON handler so the test asserts on the exact record RequestLogger emits.
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

// makeRequestLogApp wires RequestLogger ahead of a handler that responds with the given
// status after sleeping for `delay` (to exercise the slow-request path).
func makeRequestLogApp(slowThreshold, delay time.Duration, status int) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(middleware.RequestLogger(slowThreshold))
	app.Get("/test", func(c *fiber.Ctx) error {
		if delay > 0 {
			time.Sleep(delay)
		}
		return c.SendStatus(status)
	})
	return app
}

func TestRequestLogger_2xx_LogsInfoAccessLine(t *testing.T) {
	buf := captureLogs(t)
	app := makeRequestLogApp(2*time.Second, 0, fiber.StatusOK)

	_, err := app.Test(httptest.NewRequest(http.MethodGet, "/test", nil), -1)
	require.NoError(t, err)

	var rec map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &rec))
	assert.Equal(t, "INFO", rec["level"])
	assert.Equal(t, "http.request", rec["event_type_label"])
	assert.Equal(t, "/test", rec["path"])
	assert.Equal(t, "GET", rec["method"])
	assert.Equal(t, float64(200), rec["status"])
	assert.Equal(t, false, rec["slow"])
}

func TestRequestLogger_4xx_EscalatesToWarn(t *testing.T) {
	buf := captureLogs(t)
	app := makeRequestLogApp(2*time.Second, 0, fiber.StatusBadRequest)

	_, err := app.Test(httptest.NewRequest(http.MethodGet, "/test", nil), -1)
	require.NoError(t, err)

	var rec map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &rec))
	assert.Equal(t, "WARN", rec["level"])
	assert.Equal(t, float64(400), rec["status"])
}

func TestRequestLogger_SlowRequest_EscalatesToWarnWithFlag(t *testing.T) {
	buf := captureLogs(t)
	// A 1ms threshold with a 10ms handler guarantees the slow branch fires on a 2xx.
	app := makeRequestLogApp(1*time.Millisecond, 10*time.Millisecond, fiber.StatusOK)

	_, err := app.Test(httptest.NewRequest(http.MethodGet, "/test", nil), -1)
	require.NoError(t, err)

	var rec map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &rec))
	assert.Equal(t, "WARN", rec["level"])
	assert.Equal(t, float64(200), rec["status"])
	assert.Equal(t, true, rec["slow"], "a 2xx over the slow threshold must still escalate to Warn")
}
