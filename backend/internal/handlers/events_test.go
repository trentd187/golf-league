// events_test.go
// Unit tests for the event handlers in events.go.
//
// Strategy: Tier 1 only — tests cover validation paths that return before any
// DB call, so nil can be safely passed as *gorm.DB.
//
// ScheduleEventRound calls isEventOrganizer(db, ...) early, which requires a
// real DB. The two paths tested here exit before that call:
//   - Missing/invalid userID local → 401 (uuid.Parse fails on empty string)
//   - Invalid event UUID in the URL → 400 (uuid.Parse fails before DB lookup)
//
// The nine_hole_selection value-check (lines 760-765) is only reachable after
// isEventOrganizer passes — it is a Tier 2 path and requires a real DB.
//
// Run:
//
//	go test ./internal/handlers/ -run TestScheduleEventRound -v
package handlers_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/handlers"
)

const scheduleRoundRoute = "/events/:id/rounds"

// TestScheduleEventRound_MissingAuth verifies that a request with no auth
// context (no userID local) returns 401 before any DB call.
func TestScheduleEventRound_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, scheduleRoundRoute, handlers.ScheduleEventRound(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPost, "/events/"+validUUID+"/rounds", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// TestScheduleEventRound_InvalidEventID verifies that a non-UUID event ID in
// the path returns 400 before any DB call.
// A stub auth middleware injects a valid userID local so the handler reaches
// the event-UUID parse step — otherwise it exits early with 401.
func TestScheduleEventRound_InvalidEventID(t *testing.T) {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	// Inject a valid userID so uuid.Parse(userIDStr) succeeds and the handler
	// proceeds to validate the event UUID in the URL path.
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("userID", validUUID)
		return c.Next()
	})
	app.Post(scheduleRoundRoute, handlers.ScheduleEventRound(nil))

	resp, err := app.Test(
		httptest.NewRequest(http.MethodPost, "/events/not-a-uuid/rounds", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}
