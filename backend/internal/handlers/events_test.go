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
//   - AddEventMember/HandleJoinRequest/ScheduleEventRound bad body → 400
//   - AddEventMember invalid user_id in body → 400
//
// Paths that require a real DB (Tier 2):
//   - EventService.IsOrganizer, DB lookups, actual creates/updates/deletes
//
// Run:
//
//	go test ./internal/handlers/ -run TestGetEvents -v
//	go test ./internal/handlers/ -run TestCreateEvent -v
//	go test ./internal/handlers/ -run TestEvent -v
package handlers_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/handlers"
	"github.com/trentd187/golf-league/internal/models"
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
	app := newSingleRouteApp(http.MethodPost, scheduleRoundRoute, handlers.ScheduleEventRound(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPost, "/events/"+validUUID+"/rounds", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// TestScheduleEventRound_InvalidEventID verifies that a non-UUID event ID in
// the path returns 400 before any service call.
// A stub auth middleware injects a valid userID local so the handler reaches
// the event-UUID parse step — otherwise it exits early with 401.
func TestScheduleEventRound_InvalidEventID(t *testing.T) {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
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

// ─── GetPublicEvents ─────────────────────────────────────────────────────────

func TestGetPublicEvents_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/events/public", handlers.GetPublicEvents(nilEventSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/events/public", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// ─── RequestJoinEvent ────────────────────────────────────────────────────────

func TestRequestJoinEvent_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, "/events/:id/request-join", handlers.RequestJoinEvent(nilEventSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodPost, "/events/"+validUUID+"/request-join", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestRequestJoinEvent_InvalidEventID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPost, "/events/:id/request-join", handlers.RequestJoinEvent(nilEventSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodPost, "/events/not-a-uuid/request-join", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── GetJoinRequests ─────────────────────────────────────────────────────────

func TestGetJoinRequests_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/events/:id/join-requests", handlers.GetJoinRequests(nilEventSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/events/"+validUUID+"/join-requests", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestGetJoinRequests_InvalidEventID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodGet, "/events/:id/join-requests", handlers.GetJoinRequests(nilEventSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/events/not-a-uuid/join-requests", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── HandleJoinRequest ───────────────────────────────────────────────────────

func TestHandleJoinRequest_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodPatch, "/events/:id/join-requests/:userId",
		handlers.HandleJoinRequest(nilEventSvc()))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPatch, "/events/"+validUUID+"/join-requests/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestHandleJoinRequest_InvalidEventID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPatch, "/events/:id/join-requests/:userId",
		handlers.HandleJoinRequest(nilEventSvc()))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPatch, "/events/not-a-uuid/join-requests/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestHandleJoinRequest_InvalidTargetUserID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPatch, "/events/:id/join-requests/:userId",
		handlers.HandleJoinRequest(nilEventSvc()))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPatch, "/events/"+validUUID+"/join-requests/not-a-uuid", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── UpdateMemberRole ────────────────────────────────────────────────────────

func TestUpdateMemberRole_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodPatch, "/events/:id/members/:userId/role",
		handlers.UpdateMemberRole(nilEventSvc()))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPatch, "/events/"+validUUID+"/members/"+validUUID+"/role", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestUpdateMemberRole_InvalidEventID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPatch, "/events/:id/members/:userId/role",
		handlers.UpdateMemberRole(nilEventSvc()))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPatch, "/events/not-a-uuid/members/"+validUUID+"/role", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpdateMemberRole_InvalidTargetUserID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPatch, "/events/:id/members/:userId/role",
		handlers.UpdateMemberRole(nilEventSvc()))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPatch, "/events/"+validUUID+"/members/not-a-uuid/role", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestUpdateMemberRole_InvalidRole verifies that an invalid role value is
// rejected by the service (ErrInvalidRole → 400) before any DB access —
// nilEventSvc() is safe because ErrInvalidRole is returned in UpdateMemberRole
// before any DB call is made.
func TestUpdateMemberRole_InvalidRole(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPatch, "/events/:id/members/:userId/role",
		handlers.UpdateMemberRole(nilEventSvc()))
	resp := doJSON(t, app, http.MethodPatch, "/events/"+validUUID+"/members/"+validUUID+"/role",
		map[string]any{"role": "superadmin"})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── writeEventError status mapping ──────────────────────────────────────────

// TestWriteEventError_StatusMapping locks in the status code each known service
// error maps to. Tier 1 only — no DB, no service call.
func TestWriteEventError_StatusMapping(t *testing.T) {
	cases := []struct {
		name           string
		err            error
		expectedStatus int
	}{
		{"validation", &services.ValidationError{Field: "x", Message: "bad"}, http.StatusBadRequest},
		{"invalid role", services.ErrInvalidRole, http.StatusBadRequest},
		{"last organizer", services.ErrLastOrganizer, http.StatusBadRequest},
		{"event not found", services.ErrEventNotFound, http.StatusNotFound},
		{"user not found", services.ErrUserNotFound, http.StatusNotFound},
		{"member not found", services.ErrMemberNotFound, http.StatusNotFound},
		{"join request not found", services.ErrJoinRequestNotFound, http.StatusNotFound},
		{"event forbidden", services.ErrEventForbidden, http.StatusForbidden},
		{"event not member", services.ErrEventNotMember, http.StatusForbidden},
		{"event not public", services.ErrEventNotPublic, http.StatusForbidden},
		{"member already exists", services.ErrMemberAlreadyExists, http.StatusConflict},
		{"unrecognised → 500", errors.New("unexpected"), http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app, _ := captureErrorDetail(http.MethodGet, "/x", func(c *fiber.Ctx) error {
				return handlers.WriteEventErrorExported(c, tc.err, "test.tag", "fallback")
			})
			resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/x", nil), -1)
			require.NoError(t, err)
			assert.Equal(t, tc.expectedStatus, resp.StatusCode)
		})
	}
}

// ─── Pure helper functions ────────────────────────────────────────────────────

func TestFormatOptionalDate_Nil(t *testing.T) {
	assert.Nil(t, handlers.FormatOptionalDateExported(nil))
}

func TestFormatOptionalDate_Value(t *testing.T) {
	ts := time.Date(2026, 5, 21, 14, 0, 0, 0, time.UTC)
	got := handlers.FormatOptionalDateExported(&ts)
	require.NotNil(t, got)
	assert.Equal(t, "2026-05-21", *got)
}

func TestBuildEventResponse_Fields(t *testing.T) {
	event := models.Event{
		ID:        uuid.MustParse(validUUID),
		Name:      "Test Event",
		EventType: models.EventTypeLeague,
		Status:    models.EventStatusActive,
		IsPublic:  true,
		CreatedAt: time.Now(),
	}
	item := services.EventListItem{
		Event:       event,
		Creator:     models.User{DisplayName: "Alice"},
		MemberCount: 3,
	}
	got := handlers.BuildEventResponseExported(item)
	assert.Equal(t, validUUID, got.ID)
	assert.Equal(t, "Test Event", got.Name)
	assert.Equal(t, "Alice", got.CreatorName)
	assert.Equal(t, int64(3), got.MemberCount)
}

func TestBuildMemberResponse_Fields(t *testing.T) {
	player := models.EventPlayer{
		Role:      models.EventPlayerRoleOrganizer,
		Status:    models.EventPlayerStatusRegistered,
		CreatedAt: time.Now(),
	}
	user := models.User{
		ID:          uuid.MustParse(validUUID),
		DisplayName: "Bob",
		Email:       "bob@example.com",
	}
	got := handlers.BuildMemberResponseExported(services.EventMemberItem{Player: player, User: user})
	assert.Equal(t, validUUID, got.UserID)
	assert.Equal(t, "Bob", got.DisplayName)
	assert.Equal(t, "organizer", got.Role)
}

// ─── Body-parse and target-user-ID Tier 1 paths ──────────────────────────────

// TestHandleJoinRequest_InvalidBody verifies that a non-JSON body returns 400
// after auth/event/target-user checks pass but before any service call.
func TestHandleJoinRequest_InvalidBody(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPatch, "/events/:id/join-requests/:userId",
		handlers.HandleJoinRequest(nilEventSvc()))
	req := httptest.NewRequest(http.MethodPatch,
		"/events/"+validUUID+"/join-requests/"+validUUID,
		strings.NewReader("not-json"))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestAddEventMember_InvalidBody verifies that a non-JSON body returns 400
// after auth/event checks pass but before any service call.
func TestAddEventMember_InvalidBody(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPost, "/events/:id/members",
		handlers.AddEventMember(nilEventSvc()))
	req := httptest.NewRequest(http.MethodPost,
		"/events/"+validUUID+"/members",
		strings.NewReader("not-json"))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestAddEventMember_InvalidTargetUserID verifies that a malformed user_id in the
// request body returns 400 after body parsing succeeds but before any service call.
func TestAddEventMember_InvalidTargetUserID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPost, "/events/:id/members",
		handlers.AddEventMember(nilEventSvc()))
	resp := doJSON(t, app, http.MethodPost, "/events/"+validUUID+"/members",
		map[string]any{"user_id": "not-a-uuid"})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestScheduleEventRound_InvalidBody verifies that a non-JSON body returns 400
// after auth/event checks pass but before any service call.
func TestScheduleEventRound_InvalidBody(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPost, scheduleRoundRoute,
		handlers.ScheduleEventRound(nil))
	req := httptest.NewRequest(http.MethodPost,
		"/events/"+validUUID+"/rounds",
		strings.NewReader("not-json"))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}
