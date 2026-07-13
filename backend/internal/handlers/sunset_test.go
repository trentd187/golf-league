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
