// health_test.go
// Unit tests for the GET /health endpoint. Tier 1 — the DB is a fake DBPinger and the key set
// a fake JWKSCounter, so every branch runs without a real database or a real Supabase.
//
// /health is the only thing standing between a broken deploy and Railway routing live traffic
// into it, so both of its dependencies get a failing-path test: a wedged DB pool, and an empty
// JWKS key set (which 401s every authenticated request while the process looks perfectly fine).
//
// Run just this file:  go test ./internal/handlers/ -run TestHealth -v
package handlers_test

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/trentd187/golf-league/internal/handlers"
	"github.com/trentd187/golf-league/internal/testutil"
)

// fakePinger stands in for the *sql.DB behind GORM: it returns whatever err the test wants
// from PingContext so both health branches are exercised with no real database.
type fakePinger struct{ err error }

func (f fakePinger) PingContext(context.Context) error { return f.err }

// keysOK is a JWKSCounter reporting a healthy, populated key set.
func keysOK(context.Context) (int, bool) { return 3, true }

// TestHealthCheck_AllHealthy_ReturnsOK verifies GET /health responds 200 when the DB pings and
// verifying keys are present.
func TestHealthCheck_AllHealthy_ReturnsOK(t *testing.T) {
	app := testutil.NewTestApp(t, http.MethodGet, "/health", handlers.HealthCheck(fakePinger{}, keysOK))
	resp := testutil.DoRequest(t, app, http.MethodGet, "/health", nil)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	body := testutil.MustReadBody(t, resp)
	assert.Contains(t, body, `"status"`)
	assert.Contains(t, body, `"ok"`)
	assert.Contains(t, body, `"up"`)
}

// TestHealthCheck_DBUnreachable_Returns503 verifies a failed ping yields a 503 the load
// balancer can act on, rather than the old always-200 that masked a wedged backend.
func TestHealthCheck_DBUnreachable_Returns503(t *testing.T) {
	pinger := fakePinger{err: errors.New("connection refused")}
	app := testutil.NewTestApp(t, http.MethodGet, "/health", handlers.HealthCheck(pinger, keysOK))
	resp := testutil.DoRequest(t, app, http.MethodGet, "/health", nil)
	assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)

	body := testutil.MustReadBody(t, resp)
	assert.Contains(t, body, `"unhealthy"`)
	assert.Contains(t, body, `"down"`)
}

// The outage this endpoint used to report as healthy. With an empty key set every
// authenticated request 401s — the service is completely useless — yet the DB pings fine and
// the process is alive, so /health answered 200 and Railway kept routing traffic in.
func TestHealthCheck_NoJWKSKeys_Returns503(t *testing.T) {
	noKeys := func(context.Context) (int, bool) { return 0, true }
	app := testutil.NewTestApp(t, http.MethodGet, "/health", handlers.HealthCheck(fakePinger{}, noKeys))
	resp := testutil.DoRequest(t, app, http.MethodGet, "/health", nil)
	assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)

	body := testutil.MustReadBody(t, resp)
	assert.Contains(t, body, `"unhealthy"`)
	assert.Contains(t, body, `"empty"`)
}

// An uninitialised key set is the same outage by a different route.
func TestHealthCheck_JWKSUninitialised_Returns503(t *testing.T) {
	uninit := func(context.Context) (int, bool) { return 0, false }
	app := testutil.NewTestApp(t, http.MethodGet, "/health", handlers.HealthCheck(fakePinger{}, uninit))
	resp := testutil.DoRequest(t, app, http.MethodGet, "/health", nil)
	assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
}

// A nil counter skips the key check — the escape hatch for tests and for any deployment
// without auth wired up.
func TestHealthCheck_NilJWKSCounter_SkipsTheKeyCheck(t *testing.T) {
	app := testutil.NewTestApp(t, http.MethodGet, "/health", handlers.HealthCheck(fakePinger{}, nil))
	resp := testutil.DoRequest(t, app, http.MethodGet, "/health", nil)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}
