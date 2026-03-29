// rounds_test.go
// Unit tests for the round handlers in rounds.go.
//
// Strategy: Tier 1 only — tests cover validation paths that return before any DB
// call, so nil can be safely passed as *gorm.DB.
//
// All round-mutation handlers (GetRound, UpdateRound, DeleteRound,
// CreateGroup, DeleteGroup, AddGroupMember, RemoveGroupMember) start by parsing
// the caller's user ID from c.Locals("userID"). Without auth middleware that
// local is always "", so uuid.Parse("") fails and the handler returns 401
// before touching the DB.
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
)

// Route pattern constants — avoids duplicating string literals across tests.
const (
	roundRoute      = "/rounds/:roundId"
	groupRoute      = "/rounds/:roundId/groups"
	groupByIDRoute  = "/rounds/:roundId/groups/:groupId"
	membersRoute    = "/rounds/:roundId/groups/:groupId/members"
	memberByIDRoute = "/rounds/:roundId/groups/:groupId/members/:userId"
)

// ─── GetRound ─────────────────────────────────────────────────────────────────

// TestGetRound_MissingAuth verifies that a request with no auth context
// returns 401 before any database call.
func TestGetRound_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, roundRoute, handlers.GetRound(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodGet, "/rounds/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// ─── UpdateRound ──────────────────────────────────────────────────────────────

// TestUpdateRound_MissingAuth verifies that a request with no auth context
// returns 401 before any database call.
func TestUpdateRound_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodPatch, roundRoute, handlers.UpdateRound(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPatch, "/rounds/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// ─── DeleteRound ──────────────────────────────────────────────────────────────

// TestDeleteRound_MissingAuth verifies that a request with no auth context
// returns 401 before any database call.
func TestDeleteRound_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodDelete, roundRoute, handlers.DeleteRound(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodDelete, "/rounds/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// ─── CreateGroup ──────────────────────────────────────────────────────────────

// TestCreateGroup_MissingAuth verifies that a request with no auth context
// returns 401 before any database call.
func TestCreateGroup_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, groupRoute, handlers.CreateGroup(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPost, "/rounds/"+validUUID+"/groups", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// ─── DeleteGroup ──────────────────────────────────────────────────────────────

// TestDeleteGroup_MissingAuth verifies that a request with no auth context
// returns 401 before any database call.
func TestDeleteGroup_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodDelete, groupByIDRoute, handlers.DeleteGroup(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodDelete,
			"/rounds/"+validUUID+"/groups/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// ─── AddGroupMember ───────────────────────────────────────────────────────────

// TestAddGroupMember_MissingAuth verifies that a request with no auth context
// returns 401 before any database call.
func TestAddGroupMember_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, membersRoute, handlers.AddGroupMember(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodPost,
			"/rounds/"+validUUID+"/groups/"+validUUID+"/members", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// ─── RemoveGroupMember ────────────────────────────────────────────────────────

// TestRemoveGroupMember_MissingAuth verifies that a request with no auth context
// returns 401 before any database call.
func TestRemoveGroupMember_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodDelete, memberByIDRoute, handlers.RemoveGroupMember(nil))
	resp, err := app.Test(
		httptest.NewRequest(http.MethodDelete,
			"/rounds/"+validUUID+"/groups/"+validUUID+"/members/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
