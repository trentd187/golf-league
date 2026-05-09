// services/course_service_test.go
// Integration tests for CourseService.
//
// These tests use a real PostgreSQL database via testutil.NewTestDB. When
// TEST_DATABASE_URL is unset (e.g. the default pre-commit hook), every test
// that calls NewTestDB is skipped. Tier 1 tests in handlers/courses_test.go
// continue to run, so the existing coverage ratchet is unaffected.
//
// To run locally:
//
//	export TEST_DATABASE_URL="postgres://postgres:postgres@localhost:5432/golf_league_test?sslmode=disable"
//	go test ./internal/services -run TestCourseService -v
package services_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/trentd187/golf-league/internal/models"
	"github.com/trentd187/golf-league/internal/services"
	"github.com/trentd187/golf-league/internal/testutil"
)

// ─── Test fixtures ─────────────────────────────────────────────────────────────

func seedCourse(t *testing.T, db *gorm.DB) models.Course {
	t.Helper()
	c := models.Course{Name: "Test Course", City: "Springfield", State: "IL", HoleCount: 18}
	require.NoError(t, db.Create(&c).Error)
	return c
}

func seedTee(t *testing.T, db *gorm.DB, courseID uuid.UUID) models.Tee {
	t.Helper()
	tee := models.Tee{
		CourseID:     courseID,
		Name:         "Blue",
		Gender:       models.TeeGenderUnisex,
		CourseRating: 72.4,
		SlopeRating:  130,
		Par:          72,
	}
	require.NoError(t, db.Create(&tee).Error)
	return tee
}

// seedActiveRound inserts a round in "active" status against the course so the
// active-round guard fires. Creates a user (organizer), event, and tee on the
// fly — the active-round guard only checks (course_id, status), but the rounds
// table has not-null FKs and an enum scoring_format that must be populated.
func seedActiveRound(t *testing.T, db *gorm.DB, courseID uuid.UUID) {
	t.Helper()
	user := models.User{Email: "organizer@test.local", DisplayName: "O", Role: models.UserRole("user")}
	require.NoError(t, db.Create(&user).Error)
	event := models.Event{Name: "Test Event", EventType: models.EventTypeCasual, CreatedBy: user.ID}
	require.NoError(t, db.Create(&event).Error)

	// rounds.default_tee_id is NOT NULL — make sure we have at least one tee on
	// this course. Tests that already seed their own tee will still pass; this
	// just guarantees the fixture works on bare courses (e.g. the Update test).
	var tee models.Tee
	if err := db.Where("course_id = ?", courseID).First(&tee).Error; err != nil {
		tee = seedTee(t, db, courseID)
	}

	round := models.Round{
		EventID:       event.ID,
		CourseID:      courseID,
		DefaultTeeID:  tee.ID,
		ScheduledDate: time.Now(),
		Status:        models.RoundStatusActive,
		ScoringFormat: models.ScoringFormatStroke,
	}
	require.NoError(t, db.Create(&round).Error)
}

// ─── Fake GolfCourseAPI ────────────────────────────────────────────────────────

// fakeGolfAPIServer mimics the two GolfCourseAPI endpoints the service uses.
// search is returned by /v1/search; fetched is keyed by external ID for /v1/courses/{id}.
// LastSearch records the most recent search_query so tests can assert on it.
type fakeGolfAPIServer struct {
	server     *httptest.Server
	LastSearch string
}

func newFakeGolfAPI(t *testing.T, search []services.ExternalCourse, fetched map[string]services.ExternalCourse) *fakeGolfAPIServer {
	t.Helper()
	f := &fakeGolfAPIServer{}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v1/search":
			f.LastSearch = r.URL.Query().Get("search_query")
			w.Header().Set("Content-Type", "application/json")
			require.NoError(t, json.NewEncoder(w).Encode(map[string]any{"courses": search}))

		case len(r.URL.Path) > len("/v1/courses/") && r.URL.Path[:len("/v1/courses/")] == "/v1/courses/":
			id := r.URL.Path[len("/v1/courses/"):]
			course, ok := fetched[id]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			require.NoError(t, json.NewEncoder(w).Encode(map[string]any{"course": course}))

		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

// client returns a GolfCourseAPIClient pre-pointed at the fake server.
func (f *fakeGolfAPIServer) client() *services.GolfCourseAPIClient {
	c := services.NewGolfCourseAPIClient("test-key")
	// SetBaseURL replaces the production base URL; the fake server already
	// serves under "/v1/...", which matches the production path layout.
	c.SetBaseURL(f.server.URL + "/v1")
	return c
}

// ─── List + Get ────────────────────────────────────────────────────────────────

func TestCourseService_List_Empty(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)

	got, err := svc.List(context.Background(), services.ListFilters{})
	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestCourseService_List_FiltersAndCounts(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)

	a := models.Course{Name: "Pinehurst", City: "Pinehurst", State: "NC", HoleCount: 18}
	b := models.Course{Name: "Pebble Beach", City: "Pebble Beach", State: "CA", HoleCount: 18}
	require.NoError(t, db.Create(&a).Error)
	require.NoError(t, db.Create(&b).Error)
	tee := seedTee(t, db, a.ID)
	require.NoError(t, db.Create(&models.Hole{
		TeeID: tee.ID, HoleNumber: 1, Par: 4, StrokeIndex: 1,
	}).Error)

	// q matches across name/city/state.
	got, err := svc.List(context.Background(), services.ListFilters{Q: "pine"})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "Pinehurst", got[0].Course.Name)
	assert.Equal(t, 1, got[0].TeeCount)
	assert.True(t, got[0].HasHoles)

	// state filter.
	got, err = svc.List(context.Background(), services.ListFilters{State: "ca"})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "Pebble Beach", got[0].Course.Name)
	assert.False(t, got[0].HasHoles)

	// location matches OR(city,state).
	got, err = svc.List(context.Background(), services.ListFilters{Location: "NC"})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "Pinehurst", got[0].Course.Name)

	// name + city filters.
	got, err = svc.List(context.Background(), services.ListFilters{Name: "pebble", City: "pebble"})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "Pebble Beach", got[0].Course.Name)

	// Empty filter returns both, ordered alphabetically.
	got, err = svc.List(context.Background(), services.ListFilters{})
	require.NoError(t, err)
	require.Len(t, got, 2)
	assert.Equal(t, "Pebble Beach", got[0].Course.Name)
	assert.Equal(t, "Pinehurst", got[1].Course.Name)
}

func TestCourseService_Get_NotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)

	_, err := svc.Get(context.Background(), uuid.New())
	assert.ErrorIs(t, err, services.ErrCourseNotFound)
}

func TestCourseService_Get_Loaded(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)

	c := seedCourse(t, db)
	tee := seedTee(t, db, c.ID)
	require.NoError(t, db.Create(&models.Hole{
		TeeID: tee.ID, HoleNumber: 1, Par: 4, StrokeIndex: 1,
	}).Error)

	got, err := svc.Get(context.Background(), c.ID)
	require.NoError(t, err)
	assert.Equal(t, c.ID, got.ID)
	require.Len(t, got.Tees, 1)
	require.Len(t, got.Tees[0].Holes, 1)
}

// ─── Create ────────────────────────────────────────────────────────────────────

func TestCourseService_Create_Validation(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)

	cases := []struct {
		name string
		in   services.CourseInput
	}{
		{"missing name", services.CourseInput{Name: ""}},
		{"whitespace name", services.CourseInput{Name: "   "}},
		{"bad hole count", services.CourseInput{Name: "X", HoleCount: 7}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.Create(context.Background(), tc.in)
			var ve *services.ValidationError
			assert.ErrorAs(t, err, &ve, "expected ValidationError, got %v", err)
		})
	}
}

func TestCourseService_Create_DefaultsAndPersists(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)

	got, err := svc.Create(context.Background(), services.CourseInput{
		Name:  "  Whispering Pines  ", // gets trimmed
		City:  "Pinehurst",
		State: "NC",
		// HoleCount left as 0 — service defaults to 18.
	})
	require.NoError(t, err)
	assert.Equal(t, "Whispering Pines", got.Name)
	assert.Equal(t, 18, got.HoleCount)

	reloaded, err := svc.Get(context.Background(), got.ID)
	require.NoError(t, err)
	assert.Equal(t, got.ID, reloaded.ID)
}

// ─── Update ────────────────────────────────────────────────────────────────────

func TestCourseService_Update_NotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)

	_, err := svc.Update(context.Background(), uuid.New(), services.CourseUpdate{})
	assert.ErrorIs(t, err, services.ErrCourseNotFound)
}

func TestCourseService_Update_Patches(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)

	c := seedCourse(t, db)
	newName := "Renamed"
	newHoles := 9
	got, err := svc.Update(context.Background(), c.ID, services.CourseUpdate{
		Name:      &newName,
		HoleCount: &newHoles,
	})
	require.NoError(t, err)
	assert.Equal(t, "Renamed", got.Name)
	assert.Equal(t, 9, got.HoleCount)
}

func TestCourseService_Update_ValidationErrors(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)

	c := seedCourse(t, db)
	empty := "   "
	bad := 7

	_, err := svc.Update(context.Background(), c.ID, services.CourseUpdate{Name: &empty})
	var ve *services.ValidationError
	assert.ErrorAs(t, err, &ve)

	_, err = svc.Update(context.Background(), c.ID, services.CourseUpdate{HoleCount: &bad})
	assert.ErrorAs(t, err, &ve)
}

func TestCourseService_Update_BlockedByActiveRound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)

	c := seedCourse(t, db)
	seedActiveRound(t, db, c.ID)

	newName := "Renamed"
	_, err := svc.Update(context.Background(), c.ID, services.CourseUpdate{Name: &newName})
	assert.ErrorIs(t, err, services.ErrCourseInUse)
}

// ─── Tees ──────────────────────────────────────────────────────────────────────

func TestCourseService_CreateTee_Validation(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)
	c := seedCourse(t, db)

	cases := []struct {
		name string
		in   services.TeeInput
	}{
		{"missing name", services.TeeInput{}},
		{"bad gender", services.TeeInput{Name: "Blue", Gender: "robot", CourseRating: 70, SlopeRating: 113, Par: 72}},
		{"missing course rating", services.TeeInput{Name: "Blue", SlopeRating: 113, Par: 72}},
		{"slope too low", services.TeeInput{Name: "Blue", CourseRating: 70, SlopeRating: 30, Par: 72}},
		{"slope too high", services.TeeInput{Name: "Blue", CourseRating: 70, SlopeRating: 200, Par: 72}},
		{"missing par", services.TeeInput{Name: "Blue", CourseRating: 70, SlopeRating: 113}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.CreateTee(context.Background(), c.ID, tc.in)
			var ve *services.ValidationError
			assert.ErrorAs(t, err, &ve, "expected ValidationError, got %v", err)
		})
	}
}

func TestCourseService_CreateTee_CourseNotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)

	_, err := svc.CreateTee(context.Background(), uuid.New(), services.TeeInput{
		Name: "Blue", CourseRating: 70, SlopeRating: 113, Par: 72,
	})
	assert.ErrorIs(t, err, services.ErrCourseNotFound)
}

func TestCourseService_CreateTee_DefaultsGenderAndPersists(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)
	c := seedCourse(t, db)

	got, err := svc.CreateTee(context.Background(), c.ID, services.TeeInput{
		Name: "Blue", CourseRating: 72.4, SlopeRating: 130, Par: 72,
		// Gender left empty — service defaults to "unisex".
	})
	require.NoError(t, err)
	assert.Equal(t, models.TeeGenderUnisex, got.Gender)
	assert.Equal(t, c.ID, got.CourseID)
}

func TestCourseService_UpdateTee_TeeNotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)
	c := seedCourse(t, db)

	_, _, err := svc.UpdateTee(context.Background(), c.ID, uuid.New(), services.TeeUpdate{})
	assert.ErrorIs(t, err, services.ErrTeeNotFound)
}

func TestCourseService_UpdateTee_BlockedByActiveRound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)

	c := seedCourse(t, db)
	tee := seedTee(t, db, c.ID)
	seedActiveRound(t, db, c.ID)

	newName := "White"
	_, _, err := svc.UpdateTee(context.Background(), c.ID, tee.ID, services.TeeUpdate{Name: &newName})
	assert.ErrorIs(t, err, services.ErrCourseInUse)
}

func TestCourseService_UpdateTee_ValidationAndPatch(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)
	c := seedCourse(t, db)
	tee := seedTee(t, db, c.ID)

	empty := "   "
	bad := "robot"
	low := 30
	_, _, err := svc.UpdateTee(context.Background(), c.ID, tee.ID, services.TeeUpdate{Name: &empty})
	var ve *services.ValidationError
	assert.ErrorAs(t, err, &ve)

	_, _, err = svc.UpdateTee(context.Background(), c.ID, tee.ID, services.TeeUpdate{Gender: &bad})
	assert.ErrorAs(t, err, &ve)

	_, _, err = svc.UpdateTee(context.Background(), c.ID, tee.ID, services.TeeUpdate{SlopeRating: &low})
	assert.ErrorAs(t, err, &ve)

	good := "White"
	rating := 71.0
	slope := 122
	par := 71
	g := "mens"
	updated, holes, err := svc.UpdateTee(context.Background(), c.ID, tee.ID, services.TeeUpdate{
		Name:         &good,
		Gender:       &g,
		CourseRating: &rating,
		SlopeRating:  &slope,
		Par:          &par,
	})
	require.NoError(t, err)
	assert.Equal(t, "White", updated.Name)
	assert.Equal(t, models.TeeGenderMens, updated.Gender)
	assert.Equal(t, 71.0, updated.CourseRating)
	assert.Empty(t, holes)
}

func TestCourseService_DeleteTee(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)

	c := seedCourse(t, db)
	tee := seedTee(t, db, c.ID)
	require.NoError(t, svc.DeleteTee(context.Background(), c.ID, tee.ID))

	var count int64
	require.NoError(t, db.Model(&models.Tee{}).Where("id = ?", tee.ID).Count(&count).Error)
	assert.Zero(t, count)
}

func TestCourseService_DeleteTee_BlockedByActiveRound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)

	c := seedCourse(t, db)
	tee := seedTee(t, db, c.ID)
	seedActiveRound(t, db, c.ID)

	err := svc.DeleteTee(context.Background(), c.ID, tee.ID)
	assert.ErrorIs(t, err, services.ErrCourseInUse)
}

// ─── Holes ─────────────────────────────────────────────────────────────────────

func TestCourseService_UpsertHoles_Validation(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)
	c := seedCourse(t, db)
	tee := seedTee(t, db, c.ID)

	cases := []struct {
		name  string
		holes []services.HoleInput
	}{
		{"empty", nil},
		{"hole number too low", []services.HoleInput{{HoleNumber: 0, Par: 4}}},
		{"hole number too high", []services.HoleInput{{HoleNumber: 19, Par: 4}}},
		{"duplicate hole numbers", []services.HoleInput{
			{HoleNumber: 1, Par: 4}, {HoleNumber: 1, Par: 4},
		}},
		{"par too low", []services.HoleInput{{HoleNumber: 1, Par: 2}}},
		{"par too high", []services.HoleInput{{HoleNumber: 1, Par: 6}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := svc.UpsertHoles(context.Background(), c.ID, tee.ID, tc.holes)
			var ve *services.ValidationError
			assert.ErrorAs(t, err, &ve, "expected ValidationError, got %v", err)
		})
	}
}

func TestCourseService_UpsertHoles_ReplacesAtomically(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)
	c := seedCourse(t, db)
	tee := seedTee(t, db, c.ID)
	require.NoError(t, db.Create(&models.Hole{
		TeeID: tee.ID, HoleNumber: 1, Par: 5, StrokeIndex: 1,
	}).Error)

	yardage := 410
	_, holes, err := svc.UpsertHoles(context.Background(), c.ID, tee.ID, []services.HoleInput{
		{HoleNumber: 1, Par: 4, StrokeIndex: 5, Yardage: &yardage},
		{HoleNumber: 2, Par: 3, StrokeIndex: 17},
	})
	require.NoError(t, err)
	require.Len(t, holes, 2)
	assert.Equal(t, 4, holes[0].Par)
	assert.Equal(t, 5, holes[0].StrokeIndex)
	require.NotNil(t, holes[0].Yardage)
	assert.Equal(t, 410, *holes[0].Yardage)
}

func TestCourseService_UpdateHole_NotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)
	c := seedCourse(t, db)
	tee := seedTee(t, db, c.ID)

	_, err := svc.UpdateHole(context.Background(), c.ID, tee.ID, 7, services.HoleUpdate{})
	assert.ErrorIs(t, err, services.ErrHoleNotFound)
}

func TestCourseService_UpdateHole_BadHoleNumber(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)
	c := seedCourse(t, db)
	tee := seedTee(t, db, c.ID)

	_, err := svc.UpdateHole(context.Background(), c.ID, tee.ID, 0, services.HoleUpdate{})
	var ve *services.ValidationError
	assert.ErrorAs(t, err, &ve)
}

func TestCourseService_UpdateHole_PatchAndValidation(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewCourseService(db, nil)
	c := seedCourse(t, db)
	tee := seedTee(t, db, c.ID)
	require.NoError(t, db.Create(&models.Hole{
		TeeID: tee.ID, HoleNumber: 1, Par: 4, StrokeIndex: 1,
	}).Error)

	bad := 6
	_, err := svc.UpdateHole(context.Background(), c.ID, tee.ID, 1, services.HoleUpdate{Par: &bad})
	var ve *services.ValidationError
	assert.ErrorAs(t, err, &ve)

	good := 5
	si := 18
	yardage := 555
	got, err := svc.UpdateHole(context.Background(), c.ID, tee.ID, 1, services.HoleUpdate{
		Par:         &good,
		StrokeIndex: &si,
		Yardage:     &yardage,
	})
	require.NoError(t, err)
	assert.Equal(t, 5, got.Par)
	assert.Equal(t, 18, got.StrokeIndex)
	require.NotNil(t, got.Yardage)
	assert.Equal(t, 555, *got.Yardage)
}

// ─── External API ─────────────────────────────────────────────────────────────

// Tier 1: not-configured / validation paths don't hit the DB or the network.

func TestCourseService_SearchExternal_NotConfigured(t *testing.T) {
	svc := services.NewCourseService(nil, nil)
	_, err := svc.SearchExternal(context.Background(), "anything", "")
	assert.ErrorIs(t, err, services.ErrExternalAPINotConfigured)

	svc2 := services.NewCourseService(nil, services.NewGolfCourseAPIClient(""))
	_, err = svc2.SearchExternal(context.Background(), "anything", "")
	assert.ErrorIs(t, err, services.ErrExternalAPINotConfigured)
}

func TestCourseService_SearchExternal_EmptySearch(t *testing.T) {
	svc := services.NewCourseService(nil, services.NewGolfCourseAPIClient("k"))
	_, err := svc.SearchExternal(context.Background(), "   ", "")
	var ve *services.ValidationError
	assert.ErrorAs(t, err, &ve)
}

func TestCourseService_ImportExternal_NotConfigured(t *testing.T) {
	svc := services.NewCourseService(nil, nil)
	_, err := svc.ImportExternal(context.Background(), "42")
	assert.ErrorIs(t, err, services.ErrExternalAPINotConfigured)
}

func TestCourseService_ImportExternal_EmptyID(t *testing.T) {
	svc := services.NewCourseService(nil, services.NewGolfCourseAPIClient("k"))
	_, err := svc.ImportExternal(context.Background(), "  ")
	var ve *services.ValidationError
	assert.ErrorAs(t, err, &ve)
}

func TestCourseService_Refresh_NotConfigured(t *testing.T) {
	svc := services.NewCourseService(nil, nil)
	_, err := svc.Refresh(context.Background(), uuid.New())
	assert.ErrorIs(t, err, services.ErrExternalAPINotConfigured)
}

// Tier 2: end-to-end paths against the fake server + real DB.

func TestCourseService_SearchExternal_AppendsLocation(t *testing.T) {
	_ = testutil.NewTestDB(t) // skip if no DB; we don't need the handle here, but the fake server needs the test to be skippable.
	api := newFakeGolfAPI(t,
		[]services.ExternalCourse{{
			ID: 1, CourseName: "Pebble Beach", ClubName: "PB Co",
			Location: services.ExternalLocation{City: "Pebble Beach", State: "CA"},
		}}, nil)
	svc := services.NewCourseService(nil, api.client())

	got, err := svc.SearchExternal(context.Background(), "Pebble Beach", "CA")
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "1", got[0].ExternalID)
	assert.Equal(t, "Pebble Beach", got[0].Name)
	assert.Equal(t, "Pebble Beach CA", api.LastSearch)
}

func TestCourseService_SearchExternal_FallsBackToClubName(t *testing.T) {
	_ = testutil.NewTestDB(t)
	api := newFakeGolfAPI(t, []services.ExternalCourse{{
		ID: 2, CourseName: "", ClubName: "Whispering Pines",
		Location: services.ExternalLocation{City: "X", State: "Y"},
	}}, nil)
	svc := services.NewCourseService(nil, api.client())

	got, err := svc.SearchExternal(context.Background(), "pines", "")
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "Whispering Pines", got[0].Name)
}

func TestCourseService_ImportExternal_RoundTrip(t *testing.T) {
	db := testutil.NewTestDB(t)
	yardage := 410
	external := services.ExternalCourse{
		ID:         42,
		CourseName: "Pinehurst No. 2",
		Location:   services.ExternalLocation{City: "Pinehurst", State: "NC"},
		Tees: services.ExternalCourseTees{
			Male: []services.ExternalTeeBox{{
				TeeName: "Champion", CourseRating: 76.5, SlopeRating: 138, Par: 72, NumHoles: 18,
				Holes: []services.ExternalHole{{Par: 4, StrokeIndex: 1, Yardage: yardage}},
			}},
		},
	}
	api := newFakeGolfAPI(t,
		[]services.ExternalCourse{external},
		map[string]services.ExternalCourse{"42": external},
	)
	svc := services.NewCourseService(db, api.client())

	got, err := svc.ImportExternal(context.Background(), "42")
	require.NoError(t, err)
	assert.Equal(t, "Pinehurst No. 2", got.Name)
	assert.Equal(t, "golfcourseapi", got.ExternalSource)
	assert.Equal(t, "42", got.ExternalID)
	require.Len(t, got.Tees, 1)
	assert.Equal(t, "Champion", got.Tees[0].Name)
	require.Len(t, got.Tees[0].Holes, 1)
	require.NotNil(t, got.Tees[0].Holes[0].Yardage)
	assert.Equal(t, 410, *got.Tees[0].Holes[0].Yardage)

	// Re-importing the same external_id returns AlreadyImportedError with the existing course ID.
	_, err = svc.ImportExternal(context.Background(), "42")
	var dup *services.AlreadyImportedError
	require.ErrorAs(t, err, &dup)
	assert.Equal(t, got.ID, dup.ExistingCourseID)
}

func TestCourseService_ImportExternal_UpstreamError(t *testing.T) {
	db := testutil.NewTestDB(t)
	api := newFakeGolfAPI(t, nil, nil) // /v1/courses/{id} returns 404 for any id
	svc := services.NewCourseService(db, api.client())

	_, err := svc.ImportExternal(context.Background(), "999")
	var ext *services.ExternalAPIError
	assert.ErrorAs(t, err, &ext)
}

func TestCourseService_Refresh_NotExternal(t *testing.T) {
	db := testutil.NewTestDB(t)
	c := seedCourse(t, db) // ExternalSource left empty
	svc := services.NewCourseService(db, services.NewGolfCourseAPIClient("k"))

	_, err := svc.Refresh(context.Background(), c.ID)
	assert.ErrorIs(t, err, services.ErrCourseNotExternal)
}

// TestCourseService_Refresh_UpdatesExistingTeeByName covers the upsert match
// path: a tee with the same (course_id, name) keeps its ID and gets its
// rating/slope/par updated, with its holes replaced.
func TestCourseService_Refresh_UpdatesExistingTeeByName(t *testing.T) {
	db := testutil.NewTestDB(t)
	c := models.Course{
		Name:           "Imported",
		HoleCount:      18,
		ExternalSource: "golfcourseapi",
		ExternalID:     "42",
	}
	require.NoError(t, db.Create(&c).Error)
	existing := seedTee(t, db, c.ID) // name="Blue", rating=72.4, slope=130, par=72
	require.NoError(t, db.Create(&models.Hole{TeeID: existing.ID, HoleNumber: 1, Par: 4, StrokeIndex: 1}).Error)

	external := services.ExternalCourse{
		ID:         42,
		CourseName: "Imported",
		Tees: services.ExternalCourseTees{
			Male: []services.ExternalTeeBox{{
				TeeName:      "Blue", // matches the existing seeded tee by name
				CourseRating: 70.5,
				SlopeRating:  118,
				Par:          71,
				NumHoles:     18,
				Holes:        []services.ExternalHole{{Par: 5, StrokeIndex: 2}},
			}},
		},
	}
	api := newFakeGolfAPI(t, nil, map[string]services.ExternalCourse{"42": external})
	svc := services.NewCourseService(db, api.client())

	got, err := svc.Refresh(context.Background(), c.ID)
	require.NoError(t, err)
	require.Len(t, got.Tees, 1)
	assert.Equal(t, existing.ID, got.Tees[0].ID, "tee ID must be preserved so rounds.default_tee_id FKs stay valid")
	assert.Equal(t, "Blue", got.Tees[0].Name)
	assert.Equal(t, 70.5, got.Tees[0].CourseRating)
	assert.Equal(t, 118, got.Tees[0].SlopeRating)
	assert.Equal(t, 71, got.Tees[0].Par)
	require.Len(t, got.Tees[0].Holes, 1)
	assert.Equal(t, 5, got.Tees[0].Holes[0].Par, "holes are replaced, not merged")
}

// TestCourseService_Refresh_AddsNewTees covers the upsert miss path: tees in
// the external response that aren't in the DB get inserted. Existing tees
// with names not in the response are LEFT ALONE — they may still be in use
// (e.g. as rounds.default_tee_id) and the user can prune them via DeleteTee.
func TestCourseService_Refresh_AddsNewTees(t *testing.T) {
	db := testutil.NewTestDB(t)
	c := models.Course{
		Name:           "Imported",
		HoleCount:      18,
		ExternalSource: "golfcourseapi",
		ExternalID:     "42",
	}
	require.NoError(t, db.Create(&c).Error)
	existing := seedTee(t, db, c.ID) // name="Blue"

	external := services.ExternalCourse{
		ID:         42,
		CourseName: "Imported",
		Tees: services.ExternalCourseTees{
			Male: []services.ExternalTeeBox{{
				TeeName: "Black", CourseRating: 75, SlopeRating: 140, Par: 72, NumHoles: 18,
			}},
		},
	}
	api := newFakeGolfAPI(t, nil, map[string]services.ExternalCourse{"42": external})
	svc := services.NewCourseService(db, api.client())

	got, err := svc.Refresh(context.Background(), c.ID)
	require.NoError(t, err)
	require.Len(t, got.Tees, 2, "existing 'Blue' tee preserved, new 'Black' tee added")

	names := []string{got.Tees[0].Name, got.Tees[1].Name}
	assert.Contains(t, names, "Blue")
	assert.Contains(t, names, "Black")

	// Confirm the existing tee's ID was preserved.
	var blueID uuid.UUID
	for _, tee := range got.Tees {
		if tee.Name == "Blue" {
			blueID = tee.ID
		}
	}
	assert.Equal(t, existing.ID, blueID)
}

// TestCourseService_Refresh_PreservesTeesReferencedByNonActiveRound is the
// regression test for the FK violation we hit in production: a scheduled
// (non-active) round references a tee as its default_tee_id, refresh runs,
// and the rounds_default_tee_id_fkey constraint blocks the wholesale tee
// delete. The fix (upsert by name) preserves the tee row so the FK stays
// valid; refresh succeeds and the round still points at the same tee row.
func TestCourseService_Refresh_PreservesTeesReferencedByNonActiveRound(t *testing.T) {
	db := testutil.NewTestDB(t)
	c := models.Course{
		Name:           "Imported",
		HoleCount:      18,
		ExternalSource: "golfcourseapi",
		ExternalID:     "42",
	}
	require.NoError(t, db.Create(&c).Error)
	tee := seedTee(t, db, c.ID) // "Blue"

	// Seed a scheduled round (NOT active — active would trip ErrCourseInUse).
	user := models.User{Email: "u@test.local", DisplayName: "U", Role: models.UserRole("user")}
	require.NoError(t, db.Create(&user).Error)
	event := models.Event{Name: "Test Event", EventType: models.EventTypeCasual, CreatedBy: user.ID}
	require.NoError(t, db.Create(&event).Error)
	round := models.Round{
		EventID:       event.ID,
		CourseID:      c.ID,
		DefaultTeeID:  tee.ID, // <-- FK we must not break
		ScheduledDate: time.Now(),
		Status:        models.RoundStatusScheduled,
		ScoringFormat: models.ScoringFormatStroke,
	}
	require.NoError(t, db.Create(&round).Error)

	// Refresh returns the same Blue tee with new ratings — exercises the upsert
	// match path with a tee that is referenced by an existing round.
	external := services.ExternalCourse{
		ID:         42,
		CourseName: "Imported",
		Tees: services.ExternalCourseTees{
			Male: []services.ExternalTeeBox{{
				TeeName: "Blue", CourseRating: 71.0, SlopeRating: 125, Par: 72, NumHoles: 18,
			}},
		},
	}
	api := newFakeGolfAPI(t, nil, map[string]services.ExternalCourse{"42": external})
	svc := services.NewCourseService(db, api.client())

	_, err := svc.Refresh(context.Background(), c.ID)
	require.NoError(t, err, "must not violate rounds_default_tee_id_fkey")

	// Round still references the same tee row.
	var reloaded models.Round
	require.NoError(t, db.First(&reloaded, "id = ?", round.ID).Error)
	assert.Equal(t, tee.ID, reloaded.DefaultTeeID)
}

func TestCourseService_Refresh_BlockedByActiveRound(t *testing.T) {
	db := testutil.NewTestDB(t)
	c := models.Course{
		Name: "Imported", HoleCount: 18,
		ExternalSource: "golfcourseapi", ExternalID: "42",
	}
	require.NoError(t, db.Create(&c).Error)
	seedActiveRound(t, db, c.ID)
	api := newFakeGolfAPI(t, nil, nil)
	svc := services.NewCourseService(db, api.client())

	_, err := svc.Refresh(context.Background(), c.ID)
	assert.ErrorIs(t, err, services.ErrCourseInUse)
}
