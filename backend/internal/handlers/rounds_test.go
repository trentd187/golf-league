// rounds_test.go
// Unit tests for the round handlers in rounds.go.
//
// Strategy: Tier 1 only — tests cover validation paths that return before any
// service call, so nil can be safely passed as *services.RoundService.
//
// All handlers start by parsing the caller's user ID from c.Locals("userID").
// Without auth middleware that local is always "", so uuid.Parse("") fails and
// the handler returns 401 before touching the service.
//
// Run:
//
//	go test ./internal/handlers/ -run TestRound -v
package handlers_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
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

// nilRoundSvc returns a RoundService with a nil DB. Tier 1 tests use this when
// the handler path returns before any service call (auth fail, UUID parse fail,
// body validation fail).
func nilRoundSvc() *services.RoundService {
	return services.NewRoundService(nil, services.NewEventService(nil))
}

// Route pattern constants — avoids duplicating string literals across tests.
const (
	roundRoute       = "/rounds/:roundId"
	groupRoute       = "/rounds/:roundId/groups"
	groupByIDRoute   = "/rounds/:roundId/groups/:groupId"
	membersRoute     = "/rounds/:roundId/groups/:groupId/members"
	memberByIDRoute  = "/rounds/:roundId/groups/:groupId/members/:userId"
	teamsRoute       = "/rounds/:roundId/teams"
	teamMembersRoute = "/rounds/:roundId/teams/:teamId/members"
	teamByIDRoute    = "/rounds/:roundId/teams/:teamId"
)

// ─── GetMyRounds ──────────────────────────────────────────────────────────────

func TestGetMyRounds_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/rounds", handlers.GetMyRounds(nil))
	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/rounds", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// ─── GetRound ─────────────────────────────────────────────────────────────────

func TestGetRound_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, roundRoute, handlers.GetRound(nil))
	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/rounds/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestGetRound_InvalidRoundID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodGet, roundRoute, handlers.GetRound(nil))
	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/rounds/not-a-uuid", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── UpdateRound ──────────────────────────────────────────────────────────────

func TestUpdateRound_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodPatch, roundRoute, handlers.UpdateRound(nil))
	resp, err := app.Test(httptest.NewRequest(http.MethodPatch, "/rounds/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestUpdateRound_InvalidRoundID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPatch, roundRoute, handlers.UpdateRound(nilRoundSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodPatch, "/rounds/bad-id", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── DeleteRound ──────────────────────────────────────────────────────────────

func TestDeleteRound_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodDelete, roundRoute, handlers.DeleteRound(nil))
	resp, err := app.Test(httptest.NewRequest(http.MethodDelete, "/rounds/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestDeleteRound_InvalidRoundID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodDelete, roundRoute, handlers.DeleteRound(nilRoundSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodDelete, "/rounds/bad-id", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── CreateGroup ──────────────────────────────────────────────────────────────

func TestCreateGroup_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, groupRoute, handlers.CreateGroup(nil))
	resp, err := app.Test(httptest.NewRequest(http.MethodPost, "/rounds/"+validUUID+"/groups", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestCreateGroup_InvalidRoundID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPost, groupRoute, handlers.CreateGroup(nilRoundSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodPost, "/rounds/bad-id/groups", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── UpdateGroup ──────────────────────────────────────────────────────────────

func TestUpdateGroup_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodPatch, groupByIDRoute, handlers.UpdateGroup(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPatch, "/rounds/"+validUUID+"/groups/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestUpdateGroup_InvalidGroupID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPatch, groupByIDRoute, handlers.UpdateGroup(nilRoundSvc()))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPatch, "/rounds/"+validUUID+"/groups/bad-id", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── DeleteGroup ──────────────────────────────────────────────────────────────

func TestDeleteGroup_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodDelete, groupByIDRoute, handlers.DeleteGroup(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodDelete, "/rounds/"+validUUID+"/groups/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestDeleteGroup_InvalidGroupID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodDelete, groupByIDRoute, handlers.DeleteGroup(nilRoundSvc()))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodDelete, "/rounds/"+validUUID+"/groups/bad-id", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── AddGroupMember ───────────────────────────────────────────────────────────

func TestAddGroupMember_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, membersRoute, handlers.AddGroupMember(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPost, "/rounds/"+validUUID+"/groups/"+validUUID+"/members", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestAddGroupMember_InvalidGroupID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPost, membersRoute, handlers.AddGroupMember(nilRoundSvc()))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPost, "/rounds/"+validUUID+"/groups/bad-id/members", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── RemoveGroupMember ────────────────────────────────────────────────────────

func TestRemoveGroupMember_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodDelete, memberByIDRoute, handlers.RemoveGroupMember(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodDelete,
			"/rounds/"+validUUID+"/groups/"+validUUID+"/members/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestRemoveGroupMember_InvalidUserID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodDelete, memberByIDRoute, handlers.RemoveGroupMember(nilRoundSvc()))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodDelete,
			"/rounds/"+validUUID+"/groups/"+validUUID+"/members/bad-id", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── ListTeams ────────────────────────────────────────────────────────────────

func TestListTeams_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, teamsRoute, handlers.ListTeams(nil))
	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/rounds/"+validUUID+"/teams", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestListTeams_InvalidRoundID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodGet, teamsRoute, handlers.ListTeams(nilRoundSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/rounds/bad-id/teams", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── CreateTeam ───────────────────────────────────────────────────────────────

func TestCreateTeam_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, teamsRoute, handlers.CreateTeam(nil))
	resp, err := app.Test(httptest.NewRequest(http.MethodPost, "/rounds/"+validUUID+"/teams", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestCreateTeam_InvalidRoundID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPost, teamsRoute, handlers.CreateTeam(nilRoundSvc()))
	resp, err := app.Test(httptest.NewRequest(http.MethodPost, "/rounds/bad-id/teams", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// Empty/missing name returns 400 before any service call.
func TestCreateTeam_MissingName(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPost, teamsRoute, handlers.CreateTeam(nilRoundSvc()))
	resp := doJSON(t, app, http.MethodPost, "/rounds/"+validUUID+"/teams", map[string]string{"name": ""})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── AssignTeamMembers ──────────────────────────────────────────────────────────

func TestAssignTeamMembers_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodPut, teamMembersRoute, handlers.AssignTeamMembers(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPut, "/rounds/"+validUUID+"/teams/"+validUUID+"/members", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestAssignTeamMembers_InvalidTeamID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPut, teamMembersRoute, handlers.AssignTeamMembers(nilRoundSvc()))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPut, "/rounds/"+validUUID+"/teams/bad-id/members", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// A non-UUID entry in round_player_ids returns 400 before any service call.
func TestAssignTeamMembers_InvalidMemberUUID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodPut, teamMembersRoute, handlers.AssignTeamMembers(nilRoundSvc()))
	resp := doJSON(t, app, http.MethodPut,
		"/rounds/"+validUUID+"/teams/"+validUUID+"/members",
		map[string]any{"round_player_ids": []string{"not-a-uuid"}})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── DeleteTeam ─────────────────────────────────────────────────────────────────

func TestDeleteTeam_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodDelete, teamByIDRoute, handlers.DeleteTeam(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodDelete, "/rounds/"+validUUID+"/teams/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestDeleteTeam_InvalidTeamID(t *testing.T) {
	app := newEventAppWithAuth(http.MethodDelete, teamByIDRoute, handlers.DeleteTeam(nilRoundSvc()))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodDelete, "/rounds/"+validUUID+"/teams/bad-id", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── writeRoundError status mapping ──────────────────────────────────────────

// TestWriteRoundError_StatusMapping locks in the status code each known service
// error maps to. Tier 1 only — no DB, no service call.
func TestWriteRoundError_StatusMapping(t *testing.T) {
	cases := []struct {
		name           string
		err            error
		expectedStatus int
	}{
		{"validation", &services.ValidationError{Field: "x", Message: "bad"}, http.StatusBadRequest},
		{"round not found", services.ErrRoundNotFound, http.StatusNotFound},
		{"group not found", services.ErrGroupNotFound, http.StatusNotFound},
		{"course not found", services.ErrCourseNotFound, http.StatusNotFound},
		{"tee not found", services.ErrTeeNotFound, http.StatusNotFound},
		{"player not event member", services.ErrPlayerNotEventMember, http.StatusNotFound},
		{"player not in round", services.ErrPlayerNotInRound, http.StatusNotFound},
		{"round forbidden", services.ErrRoundForbidden, http.StatusForbidden},
		{"group full", services.ErrGroupFull, http.StatusConflict},
		{"player already in group", services.ErrPlayerAlreadyInGroup, http.StatusConflict},
		{"team not found", services.ErrTeamNotFound, http.StatusNotFound},
		{"team full", services.ErrTeamFull, http.StatusConflict},
		{"unrecognised → 500", errors.New("unexpected"), http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app, _ := captureErrorDetail(http.MethodGet, "/x", func(c *fiber.Ctx) error {
				return handlers.WriteRoundErrorExported(c, tc.err, "test.tag", "fallback")
			})
			resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/x", nil), -1)
			require.NoError(t, err)
			assert.Equal(t, tc.expectedStatus, resp.StatusCode)
		})
	}
}

// ─── Pure helper functions ────────────────────────────────────────────────────

func TestFormatTeeTime_Nil(t *testing.T) {
	assert.Nil(t, handlers.FormatTeeTimeExported(nil))
}

func TestFormatTeeTime_Value(t *testing.T) {
	ts := time.Date(2026, 5, 21, 14, 30, 0, 0, time.UTC)
	got := handlers.FormatTeeTimeExported(&ts)
	require.NotNil(t, got)
	assert.Equal(t, "2:30 PM", *got)
}

func TestToGroupResponse_Empty(t *testing.T) {
	got := handlers.ToGroupResponseExported("id-1", 1, nil, nil, 1, nil)
	assert.Equal(t, "id-1", got.ID)
	assert.Equal(t, 1, got.GroupNumber)
	assert.Empty(t, got.Players)
	assert.Nil(t, got.TeeTime)
}

func TestToGroupResponse_WithPlayers(t *testing.T) {
	players := []services.GroupPlayerResult{
		{UserID: "u1", RoundPlayerID: "rp1", DisplayName: "Alice", Email: "a@example.com"},
	}
	got := handlers.ToGroupResponseExported("id-2", 2, nil, nil, 1, players)
	require.Len(t, got.Players, 1)
	assert.Equal(t, "Alice", got.Players[0].DisplayName)
}

func TestToTeamResponse_WithMembers(t *testing.T) {
	tid := uuid.MustParse(validUUID)
	got := handlers.ToTeamResponseExported(services.TeamResult{
		Team: models.Team{ID: tid, Name: "Team A"},
		Members: []services.GroupPlayerResult{
			{UserID: "u1", RoundPlayerID: "rp1", DisplayName: "Alice", Email: "a@example.com"},
			{UserID: "u2", RoundPlayerID: "rp2", DisplayName: "Bob", Email: "b@example.com"},
		},
	})
	assert.Equal(t, validUUID, got.ID)
	assert.Equal(t, "Team A", got.Name)
	require.Len(t, got.Members, 2)
	assert.Equal(t, "Alice", got.Members[0].DisplayName)
}

func TestToTeamResponse_Empty(t *testing.T) {
	got := handlers.ToTeamResponseExported(services.TeamResult{Team: models.Team{Name: "Team B"}})
	assert.Equal(t, "Team B", got.Name)
	assert.Empty(t, got.Members)
}
