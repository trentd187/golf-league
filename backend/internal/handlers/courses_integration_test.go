// courses_integration_test.go
// Tier 2 (real-database) tests for the course / tee / hole handlers.
//
// The Tier 1 tests in courses_test.go pass a nil DB and only reach validation
// branches that return before any DB call. These tests instead spin up an
// ephemeral Postgres via testutil.NewTestDB and exercise the full
// handler -> CourseService -> DB path: success responses, response shaping, and
// the service-error -> HTTP-status mapping (writeCourseError). The course handlers
// read no auth Locals, so a bare single-route app with a real service suffices.
//
// Docker must be running (testcontainers). Like all NewTestDB tests, these must
// NOT call t.Parallel() — the shared container is TRUNCATEd per NewTestDB call.
package handlers_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/trentd187/golf-league/internal/handlers"
	"github.com/trentd187/golf-league/internal/models"
	"github.com/trentd187/golf-league/internal/services"
	"github.com/trentd187/golf-league/internal/testutil"
)

// ─── Tier 2 fixtures ─────────────────────────────────────────────────────────

// courseSvc builds a CourseService on the test DB with no external API client —
// these handlers never touch the GolfCourseAPI.
func courseSvc(db *gorm.DB) *services.CourseService {
	return services.NewCourseService(db, nil)
}

// seedCourse inserts a manually-entered 18-hole course. Omit(clause.Associations)
// stops GORM from auto-creating phantom tee/hole rows.
func seedCourse(t *testing.T, db *gorm.DB, name string) models.Course {
	t.Helper()
	c := models.Course{Name: name, City: "Austin", State: "TX", HoleCount: 18}
	require.NoError(t, db.Omit(clause.Associations).Create(&c).Error)
	return c
}

// seedTee inserts a tee for a course.
func seedTee(t *testing.T, db *gorm.DB, courseID uuid.UUID, name string) models.Tee {
	t.Helper()
	tee := models.Tee{
		CourseID: courseID, Name: name, Gender: models.TeeGenderUnisex,
		CourseRating: 72.0, SlopeRating: 113, Par: 72,
	}
	require.NoError(t, db.Omit(clause.Associations).Create(&tee).Error)
	return tee
}

// seedHole inserts one hole for a tee.
func seedHole(t *testing.T, db *gorm.DB, teeID uuid.UUID, number, par, strokeIndex int) models.Hole {
	t.Helper()
	h := models.Hole{TeeID: teeID, HoleNumber: number, Par: par, StrokeIndex: strokeIndex}
	require.NoError(t, db.Omit(clause.Associations).Create(&h).Error)
	return h
}

// ─── GetCourses ──────────────────────────────────────────────────────────────

func TestGetCourses_ReturnsSeededCourses(t *testing.T) {
	db := testutil.NewTestDB(t)
	seedCourse(t, db, "Pebble Beach")
	seedCourse(t, db, "Augusta National")

	app := newSingleRouteApp(http.MethodGet, "/courses", handlers.GetCourses(courseSvc(db)))
	resp := doJSON(t, app, http.MethodGet, "/courses", nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var got []handlers.CourseSummaryResponse
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&got))
	assert.Len(t, got, 2)
	names := []string{got[0].Name, got[1].Name}
	assert.Contains(t, names, "Pebble Beach")
	assert.Contains(t, names, "Augusta National")
}

// ─── GetCourse ───────────────────────────────────────────────────────────────

func TestGetCourse_ReturnsDetailWithTeesAndHoles(t *testing.T) {
	db := testutil.NewTestDB(t)
	course := seedCourse(t, db, "Detail Course")
	tee := seedTee(t, db, course.ID, "Blue")
	seedHole(t, db, tee.ID, 1, 4, 1)
	seedHole(t, db, tee.ID, 2, 3, 2)

	app := newSingleRouteApp(http.MethodGet, "/courses/:courseId", handlers.GetCourse(courseSvc(db)))
	resp := doJSON(t, app, http.MethodGet, "/courses/"+course.ID.String(), nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var got handlers.CourseDetailResponse
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&got))
	assert.Equal(t, "Detail Course", got.Name)
	require.Len(t, got.Tees, 1)
	assert.Equal(t, "Blue", got.Tees[0].Name)
	assert.Len(t, got.Tees[0].Holes, 2)
}

func TestGetCourse_NotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	app := newSingleRouteApp(http.MethodGet, "/courses/:courseId", handlers.GetCourse(courseSvc(db)))
	resp := doJSON(t, app, http.MethodGet, "/courses/"+uuid.NewString(), nil)
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

// ─── CreateCourse ────────────────────────────────────────────────────────────

func TestCreateCourse_Persists(t *testing.T) {
	db := testutil.NewTestDB(t)
	app := newSingleRouteApp(http.MethodPost, "/courses", handlers.CreateCourse(courseSvc(db)))
	resp := doJSON(t, app, http.MethodPost, "/courses", map[string]any{
		"name": "New Course", "city": "Pinehurst", "state": "NC", "hole_count": 18,
	})
	require.Equal(t, http.StatusCreated, resp.StatusCode)

	var got handlers.CourseDetailResponse
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&got))
	assert.Equal(t, "New Course", got.Name)

	var count int64
	require.NoError(t, db.Model(&models.Course{}).Where("name = ?", "New Course").Count(&count).Error)
	assert.Equal(t, int64(1), count)
}

// ─── UpdateCourse ────────────────────────────────────────────────────────────

func TestUpdateCourse_AppliesPatch(t *testing.T) {
	db := testutil.NewTestDB(t)
	course := seedCourse(t, db, "Old Name")

	app := newSingleRouteApp(http.MethodPatch, "/courses/:courseId", handlers.UpdateCourse(courseSvc(db)))
	resp := doJSON(t, app, http.MethodPatch, "/courses/"+course.ID.String(), map[string]any{
		"name": "Renamed Course",
	})
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var got handlers.CourseDetailResponse
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&got))
	assert.Equal(t, "Renamed Course", got.Name)
}

func TestUpdateCourse_NotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	app := newSingleRouteApp(http.MethodPatch, "/courses/:courseId", handlers.UpdateCourse(courseSvc(db)))
	resp := doJSON(t, app, http.MethodPatch, "/courses/"+uuid.NewString(), map[string]any{"name": "X"})
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

// ─── CreateTee ───────────────────────────────────────────────────────────────

func TestCreateTee_PersistsWithDefaultGender(t *testing.T) {
	db := testutil.NewTestDB(t)
	course := seedCourse(t, db, "Tee Course")

	app := newSingleRouteApp(http.MethodPost, "/courses/:courseId/tees", handlers.CreateTee(courseSvc(db)))
	// Empty gender exercises the service's "default to unisex" branch.
	resp := doJSON(t, app, http.MethodPost, "/courses/"+course.ID.String()+"/tees", map[string]any{
		"name": "White", "course_rating": 70.1, "slope_rating": 120, "par": 71,
	})
	require.Equal(t, http.StatusCreated, resp.StatusCode)

	var got handlers.TeeResponse
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&got))
	assert.Equal(t, "White", got.Name)
	assert.Equal(t, "unisex", got.Gender)
}

// ─── UpdateTee ───────────────────────────────────────────────────────────────

func TestUpdateTee_AppliesPatch(t *testing.T) {
	db := testutil.NewTestDB(t)
	course := seedCourse(t, db, "UpdTee Course")
	tee := seedTee(t, db, course.ID, "Red")

	newPar := 73
	app := newSingleRouteApp(http.MethodPatch, "/courses/:courseId/tees/:teeId", handlers.UpdateTee(courseSvc(db)))
	resp := doJSON(t, app, http.MethodPatch,
		"/courses/"+course.ID.String()+"/tees/"+tee.ID.String(),
		map[string]any{"name": "Gold", "par": newPar})
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var got handlers.TeeResponse
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&got))
	assert.Equal(t, "Gold", got.Name)
	assert.Equal(t, 73, got.Par)
}

// ─── DeleteTee ───────────────────────────────────────────────────────────────

func TestDeleteTee_RemovesTee(t *testing.T) {
	db := testutil.NewTestDB(t)
	course := seedCourse(t, db, "DelTee Course")
	tee := seedTee(t, db, course.ID, "Black")

	app := newSingleRouteApp(http.MethodDelete, "/courses/:courseId/tees/:teeId", handlers.DeleteTee(courseSvc(db)))
	resp := doJSON(t, app, http.MethodDelete,
		"/courses/"+course.ID.String()+"/tees/"+tee.ID.String(), nil)
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	var count int64
	require.NoError(t, db.Model(&models.Tee{}).Where("id = ?", tee.ID).Count(&count).Error)
	assert.Equal(t, int64(0), count)
}

// ─── UpsertHoles ─────────────────────────────────────────────────────────────

func TestUpsertHoles_ReplacesHoles(t *testing.T) {
	db := testutil.NewTestDB(t)
	course := seedCourse(t, db, "Holes Course")
	tee := seedTee(t, db, course.ID, "Blue")

	holes := make([]map[string]any, 18)
	for i := 0; i < 18; i++ {
		holes[i] = map[string]any{"hole_number": i + 1, "par": 4, "stroke_index": i + 1}
	}

	app := newSingleRouteApp(http.MethodPut, "/courses/:courseId/tees/:teeId/holes", handlers.UpsertHoles(courseSvc(db)))
	resp := doJSON(t, app, http.MethodPut,
		"/courses/"+course.ID.String()+"/tees/"+tee.ID.String()+"/holes",
		map[string]any{"holes": holes})
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var got handlers.TeeResponse
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&got))
	assert.Len(t, got.Holes, 18)
}

// ─── UpdateHole ──────────────────────────────────────────────────────────────

func TestUpdateHole_AppliesPatch(t *testing.T) {
	db := testutil.NewTestDB(t)
	course := seedCourse(t, db, "Hole Course")
	tee := seedTee(t, db, course.ID, "Blue")
	seedHole(t, db, tee.ID, 1, 4, 1)

	newPar := 5
	app := newSingleRouteApp(http.MethodPatch,
		"/courses/:courseId/tees/:teeId/holes/:holeNumber", handlers.UpdateHole(courseSvc(db)))
	resp := doJSON(t, app, http.MethodPatch,
		"/courses/"+course.ID.String()+"/tees/"+tee.ID.String()+"/holes/1",
		map[string]any{"par": newPar})
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var got handlers.HoleResponse
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&got))
	assert.Equal(t, 1, got.HoleNumber)
	assert.Equal(t, 5, got.Par)
}
