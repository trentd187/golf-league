// scores_test.go
// Unit tests for the score handlers in scores.go.
//
// Strategy: Tier 1 only — tests cover validation paths that return before any
// DB call, so nil or nilScoreSvc() can be safely passed as the service.
//
// Tier 1 paths covered:
//   - Invalid UUID in URL params → 400 (uuid.Parse fails before service call)
//   - Empty/missing request body → 400 (handler checks before service call)
//   - Invalid enum fields (GIR, direction, club) → 400 via nilScoreSvc() with auth injected
//   - Missing auth context → 401 (uuid.Parse on empty userID local)
//
// Handicap unit tests (HandicapStrokes, EffectiveCourseHandicap) moved to
// services/handicap_test.go — they have no dependency on handlers or HTTP.
//
// Run:
//
//	go test ./internal/handlers/ -run TestScore -v
package handlers_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/handlers"
	"github.com/trentd187/golf-league/internal/services"
)

// validUUID is a well-formed UUID used as a placeholder in route parameters.
// Defined here because scores_test.go is the first file in the package alphabetically;
// rounds_test.go and events_test.go reference it from the same handlers_test package.
const validUUID = "00000000-0000-0000-0000-000000000001"

// nilScoreSvc returns a ScoreService with nil DB and nil EventService.
// Safe for Tier 1 tests where the handler or service returns before any DB access.
func nilScoreSvc() *services.ScoreService {
	return services.NewScoreService(nil, nil)
}

// ─── GetRoundScorecard ────────────────────────────────────────────────────────

func TestGetRoundScorecard_InvalidUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet,
		"/rounds/:roundId/scorecard",
		handlers.GetRoundScorecard(nil))

	resp, err := app.Test(
		httptest.NewRequest(http.MethodGet, "/rounds/not-a-uuid/scorecard", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── SetPlayerHandicap ────────────────────────────────────────────────────────

func TestSetPlayerHandicap_InvalidRoundUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/handicap",
		handlers.SetPlayerHandicap(nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/not-a-uuid/players/"+validUUID+"/handicap",
		map[string]int{"course_handicap": 10})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestSetPlayerHandicap_InvalidPlayerUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/handicap",
		handlers.SetPlayerHandicap(nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/not-a-uuid/handicap",
		map[string]int{"course_handicap": 10})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestSetPlayerHandicap_InvalidBody(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/handicap",
		handlers.SetPlayerHandicap(nil))

	req := httptest.NewRequest(http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/handicap",
		nil)
	req.Header.Set("Content-Type", "text/plain")
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── UpsertPlayerScores ───────────────────────────────────────────────────────

func TestUpsertPlayerScores_InvalidRoundUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/scores",
		handlers.UpsertPlayerScores(nil, nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/not-a-uuid/players/"+validUUID+"/scores",
		map[string]any{"scores": []map[string]int{{"hole_number": 1, "gross_score": 4}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertPlayerScores_InvalidPlayerUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/scores",
		handlers.UpsertPlayerScores(nil, nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/not-a-uuid/scores",
		map[string]any{"scores": []map[string]int{{"hole_number": 1, "gross_score": 4}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertPlayerScores_EmptyScores(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/scores",
		handlers.UpsertPlayerScores(nil, nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/scores",
		map[string]any{"scores": []any{}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertPlayerScores_MissingScoresField(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/scores",
		handlers.UpsertPlayerScores(nil, nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/scores",
		map[string]any{})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── UpsertHoleStats — UUID and body validation ───────────────────────────────

func TestUpsertHoleStats_InvalidRoundUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/hole-stats",
		handlers.UpsertHoleStats(nil, nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/not-a-uuid/players/"+validUUID+"/hole-stats",
		map[string]any{"stats": []map[string]any{{"hole_number": 1, "gir": "hit"}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertHoleStats_InvalidPlayerUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/hole-stats",
		handlers.UpsertHoleStats(nil, nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/not-a-uuid/hole-stats",
		map[string]any{"stats": []map[string]any{{"hole_number": 1, "gir": "hit"}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertHoleStats_EmptyStats(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/hole-stats",
		handlers.UpsertHoleStats(nil, nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/hole-stats",
		map[string]any{"stats": []any{}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertHoleStats_MissingBody(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/hole-stats",
		handlers.UpsertHoleStats(nil, nil))

	req := httptest.NewRequest(http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/hole-stats", nil)
	req.Header.Set("Content-Type", "text/plain")
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── UpsertHoleStats — enum validation (auth injected; nilScoreSvc used) ──────
//
// Enum validation runs as the first step in ScoreService.UpsertHoleStats, before
// any DB access. Auth is injected so the handler reaches the service call; the
// nil DB inside nilScoreSvc() is never touched because the service returns early.

func TestUpsertHoleStats_InvalidGIRValue(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/hole-stats",
		handlers.UpsertHoleStats(nilScoreSvc(), nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/hole-stats",
		map[string]any{"stats": []map[string]any{{"hole_number": 1, "gir": "sideways"}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertHoleStats_InvalidGIRMissDirection(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/hole-stats",
		handlers.UpsertHoleStats(nilScoreSvc(), nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/hole-stats",
		map[string]any{"stats": []map[string]any{{"hole_number": 1, "gir": "miss", "gir_miss_direction": "diagonal"}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertHoleStats_InvalidFIRMissDirection(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/hole-stats",
		handlers.UpsertHoleStats(nilScoreSvc(), nil))

	fir := false
	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/hole-stats",
		map[string]any{"stats": []map[string]any{{"hole_number": 1, "fir": fir, "fir_miss_direction": "diagonal"}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertHoleStats_InvalidTeeShotClub(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/hole-stats",
		handlers.UpsertHoleStats(nilScoreSvc(), nil))

	club := "PW"
	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/hole-stats",
		map[string]any{"stats": []map[string]any{{"hole_number": 1, "tee_shot_club": club}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestSetPlayerHandicap_NoUserID verifies that missing auth returns 401.
// UUID and body validation pass; uuid.Parse("") on the empty userID local fails.
func TestSetPlayerHandicap_NoUserID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/handicap",
		handlers.SetPlayerHandicap(nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/handicap",
		map[string]int{"course_handicap": 10})
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// TestUpsertPlayerScores_NoUserID verifies that missing auth returns 401.
func TestUpsertPlayerScores_NoUserID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/scores",
		handlers.UpsertPlayerScores(nil, nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/scores",
		map[string]any{"scores": []map[string]int{{"hole_number": 1, "gross_score": 4}}})
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// TestUpsertHoleStats_NoUserID verifies that a missing auth context returns 401.
// UUID and body validation both pass; the handler then parses c.Locals("userID")
// which is absent, so uuid.Parse("") fails → 401 before reaching the service.
func TestUpsertHoleStats_NoUserID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/hole-stats",
		handlers.UpsertHoleStats(nil, nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/hole-stats",
		map[string]any{"stats": []map[string]any{{"hole_number": 1, "gir": "hit"}}})
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// ─── writeScoreError status mapping ──────────────────────────────────────────

// TestWriteScoreError_StatusMapping locks in the status code each known service
// error maps to. Tests here are pure Tier 1: no DB, no service call.
func TestWriteScoreError_StatusMapping(t *testing.T) {
	cases := []struct {
		name           string
		err            error
		expectedStatus int
	}{
		{"validation error", &services.ValidationError{Field: "hole_number", Message: "bad"}, http.StatusBadRequest},
		{"round not found", services.ErrRoundNotFound, http.StatusNotFound},
		{"round player not found", services.ErrRoundPlayerNotFound, http.StatusNotFound},
		{"score forbidden", services.ErrScoreForbidden, http.StatusForbidden},
		{"round not active", services.ErrRoundNotActive, http.StatusForbidden},
		{"handicap required", services.ErrHandicapRequired, http.StatusUnprocessableEntity},
		{"unrecognised → 500", errors.New("database exploded"), http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app, _ := captureErrorDetail(http.MethodGet, "/x", func(c *fiber.Ctx) error {
				return handlers.WriteScoreErrorExported(c, tc.err, "test.tag", "fallback")
			})
			resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/x", nil), -1)
			require.NoError(t, err)
			assert.Equal(t, tc.expectedStatus, resp.StatusCode)
		})
	}
}

// TestWriteScoreError_ErrorDetailFor5xx verifies that 5xx responses populate
// c.Locals("error_detail") so the http.error log line (Sentry) includes the cause.
func TestWriteScoreError_ErrorDetailFor5xx(t *testing.T) {
	app, captured := captureErrorDetail(http.MethodGet, "/x", func(c *fiber.Ctx) error {
		return handlers.WriteScoreErrorExported(c, errors.New("disk on fire"), "score.upsert", "failed")
	})
	_, err := app.Test(httptest.NewRequest(http.MethodGet, "/x", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, "score.upsert: disk on fire", *captured)
}

// TestWriteScoreError_NoDetailFor4xx asserts that expected 4xx errors do not
// set error_detail, keeping the error logs clean of normal client-side errors.
func TestWriteScoreError_NoDetailFor4xx(t *testing.T) {
	errs := []error{
		&services.ValidationError{Field: "x", Message: "bad"},
		services.ErrRoundNotFound,
		services.ErrRoundPlayerNotFound,
		services.ErrScoreForbidden,
		services.ErrRoundNotActive,
		services.ErrHandicapRequired,
	}
	for _, e := range errs {
		t.Run(e.Error(), func(t *testing.T) {
			app, captured := captureErrorDetail(http.MethodGet, "/x", func(c *fiber.Ctx) error {
				return handlers.WriteScoreErrorExported(c, e, "test.tag", "fallback")
			})
			_, err := app.Test(httptest.NewRequest(http.MethodGet, "/x", nil), -1)
			require.NoError(t, err)
			assert.Empty(t, *captured, "4xx errors must not populate error_detail")
		})
	}
}
