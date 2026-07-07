// Package middleware_test covers the per-request context-deadline middleware. Tier 1 —
// no DB or network. We assert the handler sees a deadline, and that a handler outliving
// the (tiny) timeout observes context.DeadlineExceeded — the signal GORM uses to abort a
// hung query into a fast, logged 5xx instead of a silent 502.
package middleware_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/trentd187/golf-league/internal/middleware"
)

func TestRequestTimeout_AttachesDeadlineToContext(t *testing.T) {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(middleware.RequestTimeout(5 * time.Second))

	var hadDeadline bool
	app.Get("/t", func(c *fiber.Ctx) error {
		_, hadDeadline = c.UserContext().Deadline()
		return c.SendStatus(fiber.StatusOK)
	})

	_, err := app.Test(httptest.NewRequest(http.MethodGet, "/t", nil), -1)
	require.NoError(t, err)
	assert.True(t, hadDeadline, "the handler's context must carry a deadline")
}

func TestRequestTimeout_ContextExpiresWhenHandlerOutlivesBudget(t *testing.T) {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(middleware.RequestTimeout(1 * time.Millisecond))

	var ctxErr error
	app.Get("/t", func(c *fiber.Ctx) error {
		time.Sleep(10 * time.Millisecond) // outlive the 1ms budget, like a hung query
		ctxErr = c.UserContext().Err()
		return c.SendStatus(fiber.StatusOK)
	})

	_, err := app.Test(httptest.NewRequest(http.MethodGet, "/t", nil), -1)
	require.NoError(t, err)
	assert.ErrorIs(t, ctxErr, context.DeadlineExceeded)
}
