// events_test.go
// Unit tests for the event handlers in events.go.
//
// Strategy: Tier 1 only — tests cover validation paths that return before any
// DB call, so nil can be safely passed as *gorm.DB.
//
// Tier 1 paths covered:
//   - Missing/invalid userID local → 401 (uuid.Parse fails on empty string)
//   - Invalid UUID in a URL param → 400 (uuid.Parse fails before DB lookup)
//   - CreateEvent body validation: missing name, invalid event_type, bad date → 400
//
// Paths that require a real DB (Tier 2):
//   - isEventOrganizer, DB lookups, actual creates/updates/deletes
//
// Run:
//
//	go test ./internal/handlers/ -run TestGetEvents -v
//	go test ./internal/handlers/ -run TestCreateEvent -v
//	go test ./internal/handlers/ -run TestEvent -v
package handlers_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/handlers"
	"github.com/trentd187/golf-league/internal/services"
)

// nilEventSvc returns an EventService with a nil DB. Tier 1 tests use this
// when the path returns before any DB access (auth fail, UUID parse fail,
// body validation fail).
func nilEventSvc() *services.EventService {
	return services.NewEventService(nil)
}

const scheduleRoundRoute = "/events/:id/rounds"

// ─── Local helper ─────────────────────────────────────────────────────────────

// newEventAppWithAuth builds a minimal Fiber app with a stub auth middleware
// that injects a valid userID local. Use this for tests that need to reach
// past the auth check but return before any DB call.
func newEventAppWithAuth(method, path string, handler fiber.Handler) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("userID", validUUID)
		return c.Next()
	})
	app.Add(method, path, handler)
	return app
}

// ─── ScheduleEventRound ──────────────────────────────────────────────────────

// TestScheduleEventRound_MissingAuth verifies that a request with no auth
// context (no userID local) returns 401 before any DB call.
func TestScheduleEventRound_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, scheduleRoundRoute, handlers.ScheduleEventRound(nilEventSvc(), nil))
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
	app.Post(scheduleRoundRoute, handlers.ScheduleEventRound(nilEventSvc(), nil))

	resp, err := app.Test(
		httptest.NewRequest(http.MethodPost, "/events/not-a-uuid/rounds", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── GetEvents ────────────────────────────────────────────────────────────────

func TestGetEvents_MissingAuth_Unauthorized(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/events", handlers.GetEvents(nilEventSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/events", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// ─── CreateEvent ──────────────────────────────────────────────────────────────
// CreateEvent is open to any authenticated user (no RequireRole gate).
// Role-gate enforcement is handled by RequireRole middleware (tested in roles_test.go).

func TestCreateEvent_MissingAuth_Unauthorized(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, "/events", handlers.CreateEvent(nilEventSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodPost, "/events", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestCreateEvent_InvalidBody_BadRequest(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPost, "/events", handlers.CreateEvent(nilEventSvc()))
	// No Content-Type header → BodyParser returns an error.
	req := httptest.NewRequest(http.MethodPost, "/events", nil)
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestCreateEvent_EmptyName_BadRequest(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPost, "/events", handlers.CreateEvent(nilEventSvc()))
	resp := doJSON(t, app, http.MethodPost, "/events", map[string]any{
		"name": "", "event_type": "league",
	})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestCreateEvent_InvalidEventType_BadRequest(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPost, "/events", handlers.CreateEvent(nilEventSvc()))
	resp := doJSON(t, app, http.MethodPost, "/events", map[string]any{
		"name": "Test League", "event_type": "invalid-type",
	})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestCreateEvent_InvalidStartDate_BadRequest(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPost, "/events", handlers.CreateEvent(nilEventSvc()))
	resp := doJSON(t, app, http.MethodPost, "/events", map[string]any{
		"name": "Test League", "event_type": "league", "start_date": "not-a-date",
	})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestCreateEvent_InvalidEndDate_BadRequest(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPost, "/events", handlers.CreateEvent(nilEventSvc()))
	resp := doJSON(t, app, http.MethodPost, "/events", map[string]any{
		"name": "Test League", "event_type": "league", "end_date": "not-a-date",
	})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── GetEvent ─────────────────────────────────────────────────────────────────

func TestGetEvent_MissingAuth_Unauthorized(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/events/:id", handlers.GetEvent(nilEventSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/events/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestGetEvent_InvalidEventID_BadRequest(t *testing.T) {
	app := newEventAppWithAuth(http.MethodGet, "/events/:id", handlers.GetEvent(nilEventSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/events/not-a-uuid", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── UpdateEvent ──────────────────────────────────────────────────────────────

func TestUpdateEvent_MissingAuth_Unauthorized(t *testing.T) {
	app := newSingleRouteApp(http.MethodPatch, "/events/:id", handlers.UpdateEvent(nilEventSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodPatch, "/events/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestUpdateEvent_InvalidEventID_BadRequest(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPatch, "/events/:id", handlers.UpdateEvent(nilEventSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodPatch, "/events/not-a-uuid", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestUpdateEvent_HandicapAllowanceTooHigh verifies that a handicap_allowance > 100
// is rejected before any DB call. Body is parsed before the DB load so this
// is reachable with a nil DB.
func TestUpdateEvent_HandicapAllowanceTooHigh_BadRequest(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPatch, "/events/:id", handlers.UpdateEvent(nilEventSvc()))
	resp := doJSON(t, app, http.MethodPatch, "/events/"+validUUID, map[string]any{
		"handicap_allowance": 150.0,
	})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestUpdateEvent_HandicapAllowanceNegative verifies that a negative handicap_allowance
// is rejected before any DB call.
func TestUpdateEvent_HandicapAllowanceNegative_BadRequest(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPatch, "/events/:id", handlers.UpdateEvent(nilEventSvc()))
	resp := doJSON(t, app, http.MethodPatch, "/events/"+validUUID, map[string]any{
		"handicap_allowance": -10.0,
	})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestCreateEvent_HandicapAllowanceTooHigh verifies that a handicap_allowance > 100
// on event creation is rejected before any DB call.
func TestCreateEvent_HandicapAllowanceTooHigh_BadRequest(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPost, "/events", handlers.CreateEvent(nilEventSvc()))
	resp := doJSON(t, app, http.MethodPost, "/events", map[string]any{
		"name": "Test League", "event_type": "league", "handicap_allowance": 110.0,
	})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── DeleteEvent ──────────────────────────────────────────────────────────────

func TestDeleteEvent_MissingAuth_Unauthorized(t *testing.T) {
	app := newSingleRouteApp(http.MethodDelete, "/events/:id", handlers.DeleteEvent(nilEventSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodDelete, "/events/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestDeleteEvent_InvalidEventID_BadRequest(t *testing.T) {
	app := newEventAppWithAuth(http.MethodDelete, "/events/:id", handlers.DeleteEvent(nilEventSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodDelete, "/events/not-a-uuid", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── GetEventMembers ──────────────────────────────────────────────────────────

// GetEventMembers has no userID check — it validates only the eventID param.
func TestGetEventMembers_InvalidEventID_BadRequest(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/events/:id/members", handlers.GetEventMembers(nilEventSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/events/not-a-uuid/members", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── AddEventMember ───────────────────────────────────────────────────────────

func TestAddEventMember_MissingAuth_Unauthorized(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, "/events/:id/members", handlers.AddEventMember(nilEventSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodPost, "/events/"+validUUID+"/members", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestAddEventMember_InvalidEventID_BadRequest(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPost, "/events/:id/members", handlers.AddEventMember(nilEventSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodPost, "/events/not-a-uuid/members", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── RemoveEventMember ────────────────────────────────────────────────────────

func TestRemoveEventMember_MissingAuth_Unauthorized(t *testing.T) {
	app := newSingleRouteApp(http.MethodDelete, "/events/:id/members/:userId",
		handlers.RemoveEventMember(nilEventSvc()))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodDelete, "/events/"+validUUID+"/members/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestRemoveEventMember_InvalidEventID_BadRequest(t *testing.T) {
	app := newEventAppWithAuth(http.MethodDelete, "/events/:id/members/:userId",
		handlers.RemoveEventMember(nilEventSvc()))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodDelete, "/events/not-a-uuid/members/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestRemoveEventMember_InvalidTargetUserID_BadRequest(t *testing.T) {
	app := newEventAppWithAuth(http.MethodDelete, "/events/:id/members/:userId",
		handlers.RemoveEventMember(nilEventSvc()))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodDelete, "/events/"+validUUID+"/members/not-a-uuid", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── GetEventRounds ───────────────────────────────────────────────────────────

// GetEventRounds has no userID check — it validates only the eventID param.
func TestGetEventRounds_InvalidEventID_BadRequest(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/events/:id/rounds", handlers.GetEventRounds(nilEventSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/events/not-a-uuid/rounds", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}
