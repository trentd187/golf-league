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
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/handlers"
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
	roundRoute      = "/rounds/:roundId"
	groupRoute      = "/rounds/:roundId/groups"
	groupByIDRoute  = "/rounds/:roundId/groups/:groupId"
	membersRoute    = "/rounds/:roundId/groups/:groupId/members"
	memberByIDRoute = "/rounds/:roundId/groups/:groupId/members/:userId"
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
