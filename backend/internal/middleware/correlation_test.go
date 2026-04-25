// Package middleware_test covers the Correlation middleware.
// All tests are Tier 1 — no database or network required.
package middleware_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/middleware"
)

// makeCorrelationApp builds a minimal Fiber app that runs the Correlation middleware
// then returns c.Locals("correlationID") as the response body for assertion.
func makeCorrelationApp() *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(middleware.Correlation())
	app.Get("/test", func(c *fiber.Ctx) error {
		id, _ := c.Locals("correlationID").(string)
		return c.SendString(id)
	})
	return app
}

func correlationBody(t *testing.T, app *fiber.App, headerValue string) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	if headerValue != "" {
		req.Header.Set("X-Correlation-ID", headerValue)
	}
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return string(b)
}

// TestCorrelation_ValidUUID_PassedThrough verifies that a well-formed UUID in the
// X-Correlation-ID header is stored unchanged in c.Locals("correlationID").
func TestCorrelation_ValidUUID_PassedThrough(t *testing.T) {
	app := makeCorrelationApp()
	input := "f47ac10b-58cc-4372-a567-0e02b2c3d479"

	body := correlationBody(t, app, input)

	assert.Equal(t, input, body)
	_, err := uuid.Parse(body)
	assert.NoError(t, err, "body should be a valid UUID")
}

// TestCorrelation_MalformedValue_GeneratesNew verifies that a malformed X-Correlation-ID
// (e.g. the garbled Date+UUID value observed in production traces) is discarded and a
// fresh UUID is generated instead.
func TestCorrelation_MalformedValue_GeneratesNew(t *testing.T) {
	app := makeCorrelationApp()
	malformed := "Fri, 24 Apr 2026 20:14:15 GMTaf782e1"

	body := correlationBody(t, app, malformed)

	assert.NotEqual(t, malformed, body, "malformed correlation ID should be replaced")
	_, err := uuid.Parse(body)
	assert.NoError(t, err, "replacement should be a valid UUID")
}

// TestCorrelation_EmptyHeader_GeneratesUUID verifies that when no X-Correlation-ID
// header is present a fresh UUID is generated.
func TestCorrelation_EmptyHeader_GeneratesUUID(t *testing.T) {
	app := makeCorrelationApp()

	body := correlationBody(t, app, "" /* no header */)

	_, err := uuid.Parse(body)
	assert.NoError(t, err, "generated correlation ID should be a valid UUID")
}
