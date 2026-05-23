// rounds_eventless_test.go
// Tier 1 unit tests for the POST /api/v1/rounds (CreateEventlessRound) handler
// and the uuidPtrStr helper.
//
// Strategy: Tier 1 only — all tests exercise paths that return before any
// service/DB call, so nil can be passed as *services.RoundService where the
// handler returns before calling it, and nilRoundSvc() is used where the
// handler would reach the service call but the body validation prevents it.
//
// Run:
//
//	go test ./internal/handlers/ -run TestCreateEventlessRound -v
//	go test ./internal/handlers/ -run TestUUIDPtrStr -v
package handlers_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/handlers"
)

// ─── CreateEventlessRound ─────────────────────────────────────────────────────

// TestCreateEventlessRound_MissingAuth verifies that a request with no auth
// context (no userID local) returns 401 before any service call.
func TestCreateEventlessRound_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, "/rounds", handlers.CreateEventlessRound(nil))
	resp, err := app.Test(httptest.NewRequest(http.MethodPost, "/rounds", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// TestCreateEventlessRound_InvalidBody verifies that a non-JSON body returns 400.
func TestCreateEventlessRound_InvalidBody(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPost, "/rounds", handlers.CreateEventlessRound(nilRoundSvc()))
	req := httptest.NewRequest(http.MethodPost, "/rounds", strings.NewReader("not json"))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestCreateEventlessRound_MissingScheduledDate verifies that omitting
// scheduled_date returns 400.
func TestCreateEventlessRound_MissingScheduledDate(t *testing.T) {
	body := `{"course_name":"Pebble Beach"}`
	app := newEventAppWithAuth(http.MethodPost, "/rounds", handlers.CreateEventlessRound(nilRoundSvc()))
	req := httptest.NewRequest(http.MethodPost, "/rounds", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestCreateEventlessRound_MissingCourse verifies that omitting both course_id
// and course_name returns 400.
func TestCreateEventlessRound_MissingCourse(t *testing.T) {
	body := `{"scheduled_date":"2025-06-01"}`
	app := newEventAppWithAuth(http.MethodPost, "/rounds", handlers.CreateEventlessRound(nilRoundSvc()))
	req := httptest.NewRequest(http.MethodPost, "/rounds", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestCreateEventlessRound_MalformedCourseID verifies that a non-UUID course_id
// returns 400 before any service call.
func TestCreateEventlessRound_MalformedCourseID(t *testing.T) {
	body := `{"scheduled_date":"2025-06-01","course_id":"not-a-uuid","default_tee_id":"` + validUUID + `"}`
	app := newEventAppWithAuth(http.MethodPost, "/rounds", handlers.CreateEventlessRound(nilRoundSvc()))
	req := httptest.NewRequest(http.MethodPost, "/rounds", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestCreateEventlessRound_CourseIDWithoutTeeID verifies that sending a valid
// course_id without default_tee_id reaches the service, which returns a
// ValidationError → 400. This exercises the service-call + error-return branch
// without needing a database (the service validates before any DB call).
func TestCreateEventlessRound_CourseIDWithoutTeeID(t *testing.T) {
	body := `{"scheduled_date":"2025-06-01","course_id":"` + validUUID + `"}`
	app := newEventAppWithAuth(http.MethodPost, "/rounds", handlers.CreateEventlessRound(nilRoundSvc()))
	req := httptest.NewRequest(http.MethodPost, "/rounds", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── uuidPtrStr helper ────────────────────────────────────────────────────────

// TestUUIDPtrStr_Nil verifies that a nil input returns nil.
func TestUUIDPtrStr_Nil(t *testing.T) {
	result := handlers.UUIDPtrStrExported(nil)
	assert.Nil(t, result)
}

// TestUUIDPtrStr_NonNil verifies that a non-nil UUID is converted to its string form.
func TestUUIDPtrStr_NonNil(t *testing.T) {
	id := uuid.MustParse(validUUID)
	result := handlers.UUIDPtrStrExported(&id)
	require.NotNil(t, result)
	assert.Equal(t, validUUID, *result)
}
