// sunset_test.go
// Tier 1 tests for the retired-endpoint tombstones in sunset.go.
//
// The contract that matters: an old build dialing the removed live-score WebSocket must
// get a definitive 410 (not a 404 and not a hang), because that is what lets its reconnect
// loop reach the give-up cap and settle on the 60s poll instead of storming the backend.
//
// Run:
//
//	go test ./internal/handlers/ -run TestWSSunset -v
package handlers_test

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/handlers"
	"github.com/trentd187/golf-league/internal/testutil"
)

func TestWSSunset_Returns410(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/api/v1/ws/rounds/:roundId", handlers.WSSunset())

	res := testutil.DoRequest(t, app, http.MethodGet, "/api/v1/ws/rounds/"+validUUID, nil)

	assert.Equal(t, http.StatusGone, res.StatusCode)
}

// The body must carry an explanatory error message: a client that logs it should be able
// to tell "this endpoint is retired" apart from a transient network failure.
func TestWSSunset_BodyExplainsRemoval(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/api/v1/ws/rounds/:roundId", handlers.WSSunset())

	res := testutil.DoRequest(t, app, http.MethodGet, "/api/v1/ws/rounds/"+validUUID, nil)
	defer func() { _ = res.Body.Close() }()

	body, err := io.ReadAll(res.Body)
	require.NoError(t, err)

	var payload map[string]string
	require.NoError(t, json.Unmarshal(body, &payload))
	assert.Contains(t, payload["error"], "no longer available")
}

// A WebSocket upgrade attempt (the real-world shape of the request — old clients send
// Connection/Upgrade headers) must also get the 410, not an upgrade or a hang.
func TestWSSunset_RejectsUpgradeAttempt(t *testing.T) {
	app := newSingleRouteApp(http.MethodGet, "/api/v1/ws/rounds/:roundId", handlers.WSSunset())

	req, err := http.NewRequest(http.MethodGet, "/api/v1/ws/rounds/"+validUUID+"?token=stale-jwt", nil)
	require.NoError(t, err)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")

	res, err := app.Test(req)
	require.NoError(t, err)
	defer func() { _ = res.Body.Close() }()

	assert.Equal(t, http.StatusGone, res.StatusCode)
}

// ─── Route-ordering regression ────────────────────────────────────────────────
//
// The tombstone lives at /api/v1/ws/… but must NOT be behind the /api/v1 group's auth.
// app.Group mounts its middleware on the PATH PREFIX, so it runs for every request under
// /api/v1 — including routes registered on `app` afterwards. Get the order wrong and an old
// client (which sends its JWT as ?token=, never as an Authorization header) gets a 401 from
// the auth middleware instead of the 410, and ws.sunset_hit never fires — so we'd have no
// signal for when it's safe to delete the route.
//
// This was not hypothetical: the live deploy returned exactly that 401, and the retired
// WSAuth sat in the same shadowed position, which is the likeliest reason the backend logged
// zero ws.connected / ws.upgrade_missing while clients logged hundreds of disconnects.
//
// These two tests pin both halves of the invariant so a future reshuffle of main.go can't
// silently reintroduce it.

// denyAll stands in for middleware.Auth: it rejects anything without a bearer header.
func denyAll(c *fiber.Ctx) error {
	if c.Get("Authorization") == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "missing or invalid authorization header"})
	}
	return c.Next()
}

// Registered BEFORE the group (as main.go does): the route wins and answers 410 even with no
// Authorization header. This is the shape that must hold.
func TestWSSunset_RegisteredBeforeAPIGroup_IsNotBehindAuth(t *testing.T) {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Get("/api/v1/ws/rounds/:roundId", handlers.WSSunset())
	app.Group("/api/v1", denyAll)

	res := testutil.DoRequest(t, app, http.MethodGet, "/api/v1/ws/rounds/"+validUUID+"?token=stale", nil)

	assert.Equal(t, http.StatusGone, res.StatusCode,
		"the sunset route must answer before the /api/v1 group's auth middleware")
}

// The inverse, documenting WHY the order matters: registered AFTER the group, the prefix
// middleware shadows the route and an old client gets a 401 it can't act on. If this ever
// starts returning 410, Fiber's matching changed and the ordering comment in main.go is stale.
func TestWSSunset_RegisteredAfterAPIGroup_IsShadowedByAuth(t *testing.T) {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Group("/api/v1", denyAll)
	app.Get("/api/v1/ws/rounds/:roundId", handlers.WSSunset())

	res := testutil.DoRequest(t, app, http.MethodGet, "/api/v1/ws/rounds/"+validUUID+"?token=stale", nil)

	assert.Equal(t, http.StatusUnauthorized, res.StatusCode,
		"group middleware matches on the /api/v1 prefix, so a later route on `app` is still shadowed")
}
