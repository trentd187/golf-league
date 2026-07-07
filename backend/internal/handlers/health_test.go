// health_test.go
// Unit tests for the GET /health endpoint. Tier 1 — the DB is a fake DBPinger, so both the
// reachable (200) and unreachable (503) paths run without a real database.
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

// TestHealthCheck_DBReachable_ReturnsOK verifies GET /health responds 200 when the DB pings.
func TestHealthCheck_DBReachable_ReturnsOK(t *testing.T) {
	app := testutil.NewTestApp(t, http.MethodGet, "/health", handlers.HealthCheck(fakePinger{}))
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
	app := testutil.NewTestApp(t, http.MethodGet, "/health", handlers.HealthCheck(pinger))
	resp := testutil.DoRequest(t, app, http.MethodGet, "/health", nil)
	assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)

	body := testutil.MustReadBody(t, resp)
	assert.Contains(t, body, `"unhealthy"`)
	assert.Contains(t, body, `"down"`)
}
