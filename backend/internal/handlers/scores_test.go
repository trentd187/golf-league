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
	"net/http"
	"net/http/httptest"
	"testing"

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
		handlers.UpsertPlayerScores(nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/not-a-uuid/players/"+validUUID+"/scores",
		map[string]any{"scores": []map[string]int{{"hole_number": 1, "gross_score": 4}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertPlayerScores_InvalidPlayerUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/scores",
		handlers.UpsertPlayerScores(nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/not-a-uuid/scores",
		map[string]any{"scores": []map[string]int{{"hole_number": 1, "gross_score": 4}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertPlayerScores_EmptyScores(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/scores",
		handlers.UpsertPlayerScores(nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/scores",
		map[string]any{"scores": []any{}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertPlayerScores_MissingScoresField(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/scores",
		handlers.UpsertPlayerScores(nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/scores",
		map[string]any{})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── UpsertHoleStats — UUID and body validation ───────────────────────────────

func TestUpsertHoleStats_InvalidRoundUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/hole-stats",
		handlers.UpsertHoleStats(nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/not-a-uuid/players/"+validUUID+"/hole-stats",
		map[string]any{"stats": []map[string]any{{"hole_number": 1, "gir": "hit"}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertHoleStats_InvalidPlayerUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/hole-stats",
		handlers.UpsertHoleStats(nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/not-a-uuid/hole-stats",
		map[string]any{"stats": []map[string]any{{"hole_number": 1, "gir": "hit"}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertHoleStats_EmptyStats(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/hole-stats",
		handlers.UpsertHoleStats(nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/hole-stats",
		map[string]any{"stats": []any{}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertHoleStats_MissingBody(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/hole-stats",
		handlers.UpsertHoleStats(nil))

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
		handlers.UpsertHoleStats(nilScoreSvc()))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/hole-stats",
		map[string]any{"stats": []map[string]any{{"hole_number": 1, "gir": "sideways"}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertHoleStats_InvalidGIRMissDirection(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/hole-stats",
		handlers.UpsertHoleStats(nilScoreSvc()))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/hole-stats",
		map[string]any{"stats": []map[string]any{{"hole_number": 1, "gir": "miss", "gir_miss_direction": "diagonal"}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertHoleStats_InvalidFIRMissDirection(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/hole-stats",
		handlers.UpsertHoleStats(nilScoreSvc()))

	fir := false
	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/hole-stats",
		map[string]any{"stats": []map[string]any{{"hole_number": 1, "fir": fir, "fir_miss_direction": "diagonal"}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestUpsertHoleStats_InvalidTeeShotClub(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/hole-stats",
		handlers.UpsertHoleStats(nilScoreSvc()))

	club := "PW"
	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/hole-stats",
		map[string]any{"stats": []map[string]any{{"hole_number": 1, "tee_shot_club": club}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestUpsertHoleStats_NoUserID verifies that a missing auth context returns 401.
// UUID and body validation both pass; the handler then parses c.Locals("userID")
// which is absent, so uuid.Parse("") fails → 401 before reaching the service.
func TestUpsertHoleStats_NoUserID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/hole-stats",
		handlers.UpsertHoleStats(nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/hole-stats",
		map[string]any{"stats": []map[string]any{{"hole_number": 1, "gir": "hit"}}})
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
