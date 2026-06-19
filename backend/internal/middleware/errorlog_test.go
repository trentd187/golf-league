// Package middleware_test covers the 5xx error-logging middleware. Tier 1 — no DB
// or network. We swap the process slog default for a buffer-backed JSON handler so
// the test can assert on the exact log record ErrorLogger emits.
package middleware_test

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/trentd187/golf-league/internal/middleware"
)

// captureLogs installs a JSON slog handler writing to a buffer for the duration of a
// test, restoring the previous default on cleanup. Returns the buffer to assert on.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	buf := &bytes.Buffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return buf
}

// makeErrorLogApp wires ErrorLogger ahead of a handler that responds with the given
// status, optionally setting error_detail first (mirroring a write<Domain>Error 5xx).
func makeErrorLogApp(status int, detail string) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(middleware.ErrorLogger())
	app.Get("/test", func(c *fiber.Ctx) error {
		if detail != "" {
			c.Locals("error_detail", detail)
		}
		return c.Status(status).JSON(fiber.Map{"error": "x"})
	})
	return app
}

func TestErrorLogger_5xx_LogsErrorWithDetail(t *testing.T) {
	buf := captureLogs(t)
	app := makeErrorLogApp(fiber.StatusInternalServerError, "score.upsert_scores: boom")

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/test", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusInternalServerError, resp.StatusCode)

	var rec map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &rec))
	assert.Equal(t, "ERROR", rec["level"])
	assert.Equal(t, "http.error", rec["event_type_label"])
	assert.Equal(t, "score.upsert_scores: boom", rec["error"])
	assert.Equal(t, "/test", rec["path"])
	assert.Equal(t, float64(500), rec["status"]) // JSON numbers decode to float64
}

func TestErrorLogger_5xx_WithoutDetail_StillLogs(t *testing.T) {
	buf := captureLogs(t)
	app := makeErrorLogApp(fiber.StatusBadGateway, "")

	_, err := app.Test(httptest.NewRequest(http.MethodGet, "/test", nil), -1)
	require.NoError(t, err)

	var rec map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &rec))
	assert.Equal(t, "ERROR", rec["level"])
	assert.Equal(t, "", rec["error"]) // empty detail still emits a record
	assert.Equal(t, float64(502), rec["status"])
}

func TestErrorLogger_4xx_DoesNotLog(t *testing.T) {
	buf := captureLogs(t)
	app := makeErrorLogApp(fiber.StatusBadRequest, "should-not-be-logged")

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/test", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)

	assert.Empty(t, buf.Bytes(), "4xx client errors must not emit an error log")
}

func TestErrorLogger_2xx_DoesNotLog(t *testing.T) {
	buf := captureLogs(t)
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(middleware.ErrorLogger())
	app.Get("/test", func(c *fiber.Ctx) error { return c.SendStatus(fiber.StatusOK) })

	_, err := app.Test(httptest.NewRequest(http.MethodGet, "/test", nil), -1)
	require.NoError(t, err)
	assert.Empty(t, buf.Bytes(), "successful responses must not emit an error log")
}
