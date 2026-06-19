// ws_test.go covers MakeWSAuthHandler — the query-param auth gate for the live-score
// WebSocket route. All Tier 1: the 426 (non-upgrade) and 401 (missing/invalid token)
// paths return before any DB access, so a nil keyfunc / errKeyfunc is sufficient.
// errKeyfunc is defined in auth_test.go (same package).
//
//	go test ./internal/middleware/ -run TestWSAuth -v
package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/middleware"
)

// makeWSAuthApp mounts MakeWSAuthHandler with the given keyfunc on /ws.
func makeWSAuthApp(keyfn jwt.Keyfunc) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Get("/ws", middleware.MakeWSAuthHandler(keyfn), func(c *fiber.Ctx) error {
		return c.SendStatus(fiber.StatusOK)
	})
	return app
}

// wsUpgradeRequest builds a GET carrying the headers that make IsWebSocketUpgrade
// true, with an optional ?token= query value.
func wsUpgradeRequest(token string) *http.Request {
	target := "/ws"
	if token != "" {
		target += "?token=" + token
	}
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	return req
}

// TestWSAuth_NonUpgrade_426 verifies a plain GET (no upgrade headers) is rejected with
// 426 Upgrade Required before any token check, so the route can't be hit as a normal
// request that would hang waiting to upgrade.
func TestWSAuth_NonUpgrade_426(t *testing.T) {
	app := makeWSAuthApp(nil)

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/ws?token=whatever", nil), -1)

	require.NoError(t, err)
	assert.Equal(t, http.StatusUpgradeRequired, resp.StatusCode)
}

// TestWSAuth_MissingToken_401 verifies an upgrade request with no ?token= is rejected
// with 401 before any JWT parsing.
func TestWSAuth_MissingToken_401(t *testing.T) {
	app := makeWSAuthApp(nil)

	resp, err := app.Test(wsUpgradeRequest(""), -1)

	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// TestWSAuth_InvalidToken_401 verifies a token the keyfunc rejects yields 401.
func TestWSAuth_InvalidToken_401(t *testing.T) {
	app := makeWSAuthApp(errKeyfunc)

	// A syntactically valid HS256 JWT (payload {"sub":"test"}) signed with the wrong
	// key, so parsing reaches errKeyfunc and fails verification.
	const fakeToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
		"eyJzdWIiOiJ0ZXN0In0." +
		"WaFfXO4UBFWxG1xNLUSOCxqJjJQ6kJXBF1PF1_FAKE"

	resp, err := app.Test(wsUpgradeRequest(fakeToken), -1)

	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
