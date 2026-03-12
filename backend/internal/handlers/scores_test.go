// scores_test.go
// Unit tests for the score and handicap handlers in scores.go.
//
// Strategy: Tier 1 only — all tests exercise validation paths that return before
// any DB call, so nil can be safely passed as *gorm.DB.
//
// Run:
//
//	go test ./internal/handlers/ -run TestScore -v
//	go test ./internal/handlers/ -run TestHandicap -v
package handlers_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/handlers"
)

// validUUID is a well-formed UUID used as a placeholder in route parameters.
// The handlers parse UUIDs before any DB work, so a valid UUID bypasses the
// UUID-parse check and lets the test reach the next validation layer.
const validUUID = "00000000-0000-0000-0000-000000000001"

// ─── GetRoundScorecard ─────────────────────────────────────────────────────────

// TestGetRoundScorecard_InvalidUUID verifies that a malformed round ID
// returns 400 before any DB call.
func TestGetRoundScorecard_InvalidUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet,
		"/rounds/:roundId/scorecard",
		handlers.GetRoundScorecard(nil))

	resp, err := app.Test(
		httptest.NewRequest(http.MethodGet, "/rounds/not-a-uuid/scorecard", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── SetPlayerHandicap ─────────────────────────────────────────────────────────

// TestSetPlayerHandicap_InvalidRoundUUID verifies that a malformed round ID
// returns 400 before any DB call.
func TestSetPlayerHandicap_InvalidRoundUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/handicap",
		handlers.SetPlayerHandicap(nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/not-a-uuid/players/"+validUUID+"/handicap",
		map[string]int{"course_handicap": 10})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestSetPlayerHandicap_InvalidPlayerUUID verifies that a malformed round_player ID
// returns 400 before any DB call.
func TestSetPlayerHandicap_InvalidPlayerUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/handicap",
		handlers.SetPlayerHandicap(nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/not-a-uuid/handicap",
		map[string]int{"course_handicap": 10})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestSetPlayerHandicap_InvalidBody verifies that a non-JSON body returns 400.
func TestSetPlayerHandicap_InvalidBody(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/handicap",
		handlers.SetPlayerHandicap(nil))

	// Send plain text instead of JSON — BodyParser will fail.
	req := httptest.NewRequest(http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/handicap",
		nil)
	req.Header.Set("Content-Type", "text/plain")
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	// Fiber returns 400 when BodyParser fails — validation fires before any DB or permission check.
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── UpsertPlayerScores ────────────────────────────────────────────────────────

// TestUpsertPlayerScores_InvalidRoundUUID verifies that a malformed round ID
// returns 400 before any DB call.
func TestUpsertPlayerScores_InvalidRoundUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/scores",
		handlers.UpsertPlayerScores(nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/not-a-uuid/players/"+validUUID+"/scores",
		map[string]any{"scores": []map[string]int{{"hole_number": 1, "gross_score": 4}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestUpsertPlayerScores_InvalidPlayerUUID verifies that a malformed round_player ID
// returns 400 before any DB call.
func TestUpsertPlayerScores_InvalidPlayerUUID(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/scores",
		handlers.UpsertPlayerScores(nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/not-a-uuid/scores",
		map[string]any{"scores": []map[string]int{{"hole_number": 1, "gross_score": 4}}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestUpsertPlayerScores_EmptyScores verifies that an empty scores array returns 400.
func TestUpsertPlayerScores_EmptyScores(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/scores",
		handlers.UpsertPlayerScores(nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/scores",
		map[string]any{"scores": []any{}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestUpsertPlayerScores_MissingScoresField verifies that a missing scores field returns 400.
func TestUpsertPlayerScores_MissingScoresField(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut,
		"/rounds/:roundId/players/:roundPlayerId/scores",
		handlers.UpsertPlayerScores(nil))

	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/players/"+validUUID+"/scores",
		map[string]any{})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── HandicapStrokes unit tests ───────────────────────────────────────────────

// TestHandicapStrokes_ZeroHandicap verifies that a scratch golfer receives no
// extra strokes on any hole.
func TestHandicapStrokes_ZeroHandicap(t *testing.T) {
	assert.Equal(t, 0, handlers.HandicapStrokes(0, 1))
	assert.Equal(t, 0, handlers.HandicapStrokes(0, 18))
}

// TestHandicapStrokes_FiveHandicap verifies that a 5-handicap player gets one
// stroke on holes with SI ≤ 5 and none on SI 6–18.
func TestHandicapStrokes_FiveHandicap(t *testing.T) {
	assert.Equal(t, 1, handlers.HandicapStrokes(5, 1))
	assert.Equal(t, 1, handlers.HandicapStrokes(5, 5))
	assert.Equal(t, 0, handlers.HandicapStrokes(5, 6))
	assert.Equal(t, 0, handlers.HandicapStrokes(5, 18))
}

// TestHandicapStrokes_EighteenHandicap verifies that a bogey golfer (18-handicap)
// gets exactly one stroke on every hole.
func TestHandicapStrokes_EighteenHandicap(t *testing.T) {
	for si := 1; si <= 18; si++ {
		assert.Equal(t, 1, handlers.HandicapStrokes(18, si),
			"expected 1 stroke on hole SI=%d", si)
	}
}

// TestHandicapStrokes_TwentyHandicap verifies that handicap 20 gives two strokes
// on the two hardest holes (SI 1–2) and one stroke on the remaining 16.
func TestHandicapStrokes_TwentyHandicap(t *testing.T) {
	assert.Equal(t, 2, handlers.HandicapStrokes(20, 1))
	assert.Equal(t, 2, handlers.HandicapStrokes(20, 2))
	assert.Equal(t, 1, handlers.HandicapStrokes(20, 3))
	assert.Equal(t, 1, handlers.HandicapStrokes(20, 18))
}
