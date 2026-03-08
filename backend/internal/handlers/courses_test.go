// courses_test.go
// Unit tests for the course, tee, and hole handlers in courses.go.
//
// Strategy: all tests here are "Tier 1" (no database, no external API).
// They exercise validation paths that return before any DB or network call.
// A nil *gorm.DB is safe to pass whenever the test hits a validation
// branch that returns before the first DB operation.
//
// Run these tests:
//
//	go test ./internal/handlers/ -run TestCourse -v
//	go test ./internal/handlers/ -run TestSearchExternal -v
//	go test ./internal/handlers/ -run TestImportExternal -v
package handlers_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/handlers"
	"github.com/trentd187/golf-league/internal/services"
)

// ─── Local test helpers ────────────────────────────────────────────────────────

// newSingleRouteApp creates a bare Fiber app with one route — no auth, no DB.
// Equivalent to testutil.NewTestApp but accepts any HTTP method string.
func newSingleRouteApp(method, path string, handler fiber.Handler) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Add(method, path, handler)
	return app
}

// doJSON fires an HTTP request with a JSON body and the correct Content-Type header.
// Fiber's BodyParser requires Content-Type: application/json to decode the body.
// The standard testutil.DoRequest does not set this header, so we build the
// request manually here for POST/PATCH/PUT tests.
func doJSON(t *testing.T, app *fiber.App, method, path string, body any) *http.Response {
	t.Helper()

	var buf bytes.Buffer
	if body != nil {
		require.NoError(t, json.NewEncoder(&buf).Encode(body))
	}

	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req, -1) // -1 disables the per-test timeout
	require.NoError(t, err, "Fiber test request failed")
	return resp
}

// stubClient returns a GolfCourseAPIClient with an empty key.
// Safe to pass when the test path returns before calling Search or FetchByID.
func stubClient() *services.GolfCourseAPIClient {
	return services.NewGolfCourseAPIClient("")
}

// ─── GetCourse ─────────────────────────────────────────────────────────────────

// TestGetCourse_InvalidUUID verifies that a malformed course ID returns 400
// before the handler touches the database.
func TestGetCourse_InvalidUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/courses/:courseId", handlers.GetCourse(nil))
	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/courses/not-a-uuid", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── UpdateCourse ──────────────────────────────────────────────────────────────

// TestUpdateCourse_InvalidUUID verifies that a malformed course ID returns 400.
func TestUpdateCourse_InvalidUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPatch, "/courses/:courseId", handlers.UpdateCourse(nil))
	resp, err := app.Test(httptest.NewRequest(http.MethodPatch, "/courses/bad-uuid", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── CreateCourse ──────────────────────────────────────────────────────────────

// TestCreateCourse_MissingName verifies that omitting the course name returns 400.
// The name validation runs before the DB insert, so nil DB is safe.
func TestCreateCourse_MissingName(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, "/courses", handlers.CreateCourse(nil))
	resp := doJSON(t, app, http.MethodPost, "/courses", map[string]any{"city": "Springfield"})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestCreateCourse_InvalidHoleCount verifies that an unsupported hole count (not 9 or 18) returns 400.
func TestCreateCourse_InvalidHoleCount(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, "/courses", handlers.CreateCourse(nil))
	resp := doJSON(t, app, http.MethodPost, "/courses",
		map[string]any{"name": "Pine Valley", "hole_count": 7})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── CreateTee ─────────────────────────────────────────────────────────────────

// TestCreateTee_InvalidCourseUUID verifies that a malformed course ID returns 400.
func TestCreateTee_InvalidCourseUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, "/courses/:courseId/tees", handlers.CreateTee(nil))
	resp, err := app.Test(httptest.NewRequest(http.MethodPost, "/courses/bad-id/tees", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── UpdateTee ─────────────────────────────────────────────────────────────────

// TestUpdateTee_InvalidCourseUUID verifies that a malformed course ID returns 400.
func TestUpdateTee_InvalidCourseUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPatch, "/courses/:courseId/tees/:teeId",
		handlers.UpdateTee(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPatch, "/courses/bad-id/tees/also-bad", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── DeleteTee ─────────────────────────────────────────────────────────────────

// TestDeleteTee_InvalidCourseUUID verifies that a malformed course ID returns 400.
func TestDeleteTee_InvalidCourseUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodDelete, "/courses/:courseId/tees/:teeId",
		handlers.DeleteTee(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodDelete, "/courses/bad-id/tees/also-bad", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── UpsertHoles ───────────────────────────────────────────────────────────────

// TestUpsertHoles_InvalidCourseUUID verifies that a malformed course ID returns 400.
func TestUpsertHoles_InvalidCourseUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut, "/courses/:courseId/tees/:teeId/holes",
		handlers.UpsertHoles(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPut, "/courses/bad-id/tees/also-bad/holes", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── UpdateHole ────────────────────────────────────────────────────────────────

// TestUpdateHole_InvalidCourseUUID verifies that a malformed course ID returns 400.
func TestUpdateHole_InvalidCourseUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPatch,
		"/courses/:courseId/tees/:teeId/holes/:holeNumber",
		handlers.UpdateHole(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPatch, "/courses/bad-id/tees/also-bad/holes/1", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestUpdateHole_InvalidHoleNumber verifies that a non-numeric hole number returns 400.
// This exercises the strconv.Atoi path inside the handler. The course UUID is valid
// so the handler proceeds past UUID parsing before hitting the hole number check.
func TestUpdateHole_InvalidHoleNumber(t *testing.T) {
	app := newSingleRouteApp(http.MethodPatch,
		"/courses/:courseId/tees/:teeId/holes/:holeNumber",
		handlers.UpdateHole(nil))
	// Use a valid UUID for the course but a non-numeric hole number.
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPatch,
			"/courses/00000000-0000-0000-0000-000000000001/tees/00000000-0000-0000-0000-000000000002/holes/bogus",
			nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── SearchExternalCourse ──────────────────────────────────────────────────────

// TestSearchExternalCourse_EmptySearchField verifies that an empty "search" field
// is rejected before the external API client is called.
func TestSearchExternalCourse_EmptySearchField(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, "/courses/search-external",
		handlers.SearchExternalCourse(stubClient()))
	resp := doJSON(t, app, http.MethodPost, "/courses/search-external",
		map[string]any{"search": ""})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestSearchExternalCourse_WhitespaceSearch verifies that a whitespace-only "search"
// field is rejected after trimming.
func TestSearchExternalCourse_WhitespaceSearch(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, "/courses/search-external",
		handlers.SearchExternalCourse(stubClient()))
	resp := doJSON(t, app, http.MethodPost, "/courses/search-external",
		map[string]any{"search": "   "})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── ImportExternalCourse ──────────────────────────────────────────────────────

// TestImportExternalCourse_MissingExternalID verifies that omitting "external_id" returns 400
// before any DB query or external API call.
func TestImportExternalCourse_MissingExternalID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, "/courses/import-external",
		handlers.ImportExternalCourse(nil, stubClient()))
	resp := doJSON(t, app, http.MethodPost, "/courses/import-external", map[string]any{})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestImportExternalCourse_WhitespaceExternalID verifies that a whitespace-only
// "external_id" is rejected after trimming.
func TestImportExternalCourse_WhitespaceExternalID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, "/courses/import-external",
		handlers.ImportExternalCourse(nil, stubClient()))
	resp := doJSON(t, app, http.MethodPost, "/courses/import-external",
		map[string]any{"external_id": "   "})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── RefreshCourse ─────────────────────────────────────────────────────────────

// TestRefreshCourse_InvalidUUID verifies that a malformed course ID returns 400
// before any DB or external API call.
func TestRefreshCourse_InvalidUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, "/courses/:courseId/refresh",
		handlers.RefreshCourse(nil, stubClient()))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPost, "/courses/not-a-uuid/refresh", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}
