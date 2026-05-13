// users_test.go
// Tier 1 unit tests for the user handlers in users.go.
//
// Strategy: handlers now take *services.UserService instead of *gorm.DB.
// All tests here return before the service call (auth/UUID/body validation),
// so nilUserSvc() (UserService with nil DB) is safe to pass.
//
// Tier 1 paths covered:
//   - Missing auth context  → 401 (uuid.Parse("") fails)
//   - Invalid :userId param → 400 (uuid.Parse fails before service call)
//   - FollowUser self-follow → 400 (ErrFollowSelf via writeUserError)
//   - Bad body / invalid score_position → 400 (body parsed before service call)
//
// ComputeHandicapPair unit tests moved to services/user_service_test.go —
// they test a pure service function, not HTTP plumbing.
//
// Run:
//
//	go test ./internal/handlers/ -run TestUser -v
//	go test ./internal/handlers/ -run TestGetMe -v
//	go test ./internal/handlers/ -run TestSearch -v
//	go test ./internal/handlers/ -run TestFollow -v
package handlers_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/handlers"
	"github.com/trentd187/golf-league/internal/services"
)

// nilUserSvc returns a UserService with a nil DB.
// Safe for Tier 1 tests where the handler returns before any service/DB call.
func nilUserSvc() *services.UserService {
	return services.NewUserService(nil)
}

// newUserAppWithAuth builds a minimal Fiber app with a stub auth middleware that
// injects a valid userID local. Use for tests that need to reach past the auth
// check but return before any DB call (e.g. invalid UUID param, self-follow).
func newUserAppWithAuth(method, path string, handler fiber.Handler) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("userID", validUUID)
		return c.Next()
	})
	app.Add(method, path, handler)
	return app
}

// ─── GetMe ────────────────────────────────────────────────────────────────────

func TestGetMe_NoAuth_Unauthorized(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/api/v1/me", handlers.GetMe(nilUserSvc()))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/v1/me", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// ─── SearchUsers ──────────────────────────────────────────────────────────────

func TestSearchUsers_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/users", handlers.SearchUsers(nilUserSvc()))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/users", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// ─── GetUserProfile ───────────────────────────────────────────────────────────

func TestGetUserProfile_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/users/:userId", handlers.GetUserProfile(nilUserSvc()))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/users/"+validUUID, nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestGetUserProfile_InvalidUserID(t *testing.T) {
	app := newUserAppWithAuth(http.MethodGet, "/users/:userId", handlers.GetUserProfile(nilUserSvc()))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/users/not-a-uuid", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── GetUserStats ─────────────────────────────────────────────────────────────

func TestGetUserStats_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/users/:userId/stats", handlers.GetUserStats(nilUserSvc()))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/users/"+validUUID+"/stats", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestGetUserStats_InvalidUserID(t *testing.T) {
	app := newUserAppWithAuth(http.MethodGet, "/users/:userId/stats", handlers.GetUserStats(nilUserSvc()))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/users/not-a-uuid/stats", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── FollowUser ───────────────────────────────────────────────────────────────

func TestFollowUser_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodPost, "/users/:userId/follow", handlers.FollowUser(nilUserSvc()))

	resp, err := app.Test(httptest.NewRequest(http.MethodPost, "/users/"+validUUID+"/follow", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestFollowUser_InvalidUserID(t *testing.T) {
	app := newUserAppWithAuth(http.MethodPost, "/users/:userId/follow", handlers.FollowUser(nilUserSvc()))

	resp, err := app.Test(httptest.NewRequest(http.MethodPost, "/users/not-a-uuid/follow", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestFollowUser_CannotFollowSelf verifies that the self-follow guard fires via
// ErrFollowSelf returned by the service and mapped to 400 by writeUserError.
// Both auth userID and path param are validUUID, so the service returns ErrFollowSelf
// before any DB access — nilUserSvc() is safe.
func TestFollowUser_CannotFollowSelf(t *testing.T) {
	app := newUserAppWithAuth(http.MethodPost, "/users/:userId/follow", handlers.FollowUser(nilUserSvc()))

	resp, err := app.Test(httptest.NewRequest(http.MethodPost, "/users/"+validUUID+"/follow", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── UnfollowUser ─────────────────────────────────────────────────────────────

func TestUnfollowUser_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodDelete, "/users/:userId/follow", handlers.UnfollowUser(nilUserSvc()))

	resp, err := app.Test(httptest.NewRequest(http.MethodDelete, "/users/"+validUUID+"/follow", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestUnfollowUser_InvalidUserID(t *testing.T) {
	app := newUserAppWithAuth(http.MethodDelete, "/users/:userId/follow", handlers.UnfollowUser(nilUserSvc()))

	resp, err := app.Test(httptest.NewRequest(http.MethodDelete, "/users/not-a-uuid/follow", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── GetFollowing ─────────────────────────────────────────────────────────────

func TestGetFollowing_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/users/following", handlers.GetFollowing(nilUserSvc()))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/users/following", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// ─── GetUserRounds ────────────────────────────────────────────────────────────

func TestGetUserRounds_MissingAuth(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/users/:userId/rounds", handlers.GetUserRounds(nilUserSvc()))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/users/"+validUUID+"/rounds", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestGetUserRounds_InvalidUserID(t *testing.T) {
	app := newUserAppWithAuth(http.MethodGet, "/users/:userId/rounds", handlers.GetUserRounds(nilUserSvc()))

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/users/not-a-uuid/rounds", nil), -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ─── ScorecardSettings ────────────────────────────────────────────────────────

func TestGetScorecardSettings_NoAuth(t *testing.T) {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Get("/users/me/scorecard-settings", handlers.GetScorecardSettings(nilUserSvc()))

	req := httptest.NewRequest(http.MethodGet, "/users/me/scorecard-settings", nil)
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestUpsertScorecardSettings_NoAuth(t *testing.T) {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Patch("/users/me/scorecard-settings", handlers.UpsertScorecardSettings(nilUserSvc()))

	req := httptest.NewRequest(http.MethodPatch, "/users/me/scorecard-settings", nil)
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestUpsertScorecardSettings_BadBody(t *testing.T) {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("userID", validUUID)
		return c.Next()
	})
	app.Patch("/users/me/scorecard-settings", handlers.UpsertScorecardSettings(nilUserSvc()))

	req := httptest.NewRequest(http.MethodPatch, "/users/me/scorecard-settings", nil)
	req.Header.Set("Content-Type", "text/plain")
	resp, err := app.Test(req, -1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestUpsertScorecardSettings_InvalidScorePosition verifies that an invalid
// score_position is caught by the service (ValidationError) and mapped to 400
// by writeUserError before any DB access — nilUserSvc() is safe.
func TestUpsertScorecardSettings_InvalidScorePosition(t *testing.T) {
	app := newUserAppWithAuth(http.MethodPatch,
		"/users/me/scorecard-settings",
		handlers.UpsertScorecardSettings(nilUserSvc()))

	resp := doJSON(t, app, http.MethodPatch, "/users/me/scorecard-settings", map[string]any{
		"score_position":              "invalid",
		"stat_order":                  []string{"fir", "gir"},
		"fir_enabled":                 true,
		"gir_enabled":                 true,
		"putts_enabled":               true,
		"first_putt_distance_enabled": true,
		"putt_distance_made_enabled":  true,
		"approach_yds_enabled":        true,
		"tee_shot_club_enabled":       false,
		"tee_shot_distance_enabled":   false,
	})
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}
