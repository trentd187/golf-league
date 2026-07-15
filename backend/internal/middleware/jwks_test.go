// middleware/jwks_test.go
// Tests for the Supabase JWKS loader.
//
// The bug these pin. Auth used keyfunc.NewDefault, whose storage is built with
// jwkset.HTTPClientStorageOptions{NoErrorReturnFirstHTTPReq: true} — and jwkset/storage.go
// then does `return s, nil` when the very first fetch fails. So NewDefault NEVER returned an
// error for an unreachable JWKS. The log.Fatalf guarding it was dead code, and the comment
// promising "a failure here is fatal at startup" asserted the exact opposite of the truth.
//
// What actually happened: the server booted with an EMPTY key set, every authenticated request
// failed signature verification and got a 401, and /health (which only pinged the database)
// kept answering 200 — so Railway routed live traffic into a service where literally nothing
// worked, and never restarted it. A silent, total auth outage that reported itself healthy.
//
// TestLoadJWKS_UnreachableURL_ReturnsError is the regression: it FAILS against the old code.
package middleware_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/middleware"
)

// newJWKSServer serves a minimal, valid RSA JWK Set — enough for keyfunc to parse and cache.
func newJWKSServer(t *testing.T) *httptest.Server {
	t.Helper()

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)

	jwks := map[string]any{
		"keys": []map[string]string{{
			"kty": "RSA",
			"kid": "test-key-1",
			"alg": "RS256",
			"use": "sig",
			"n":   base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}},
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(jwks)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// THE REGRESSION. An unreachable JWKS must fail loudly so the process dies and Railway
// restarts it — never boot with an empty key set and 401 every request while looking healthy.
func TestLoadJWKS_UnreachableURL_ReturnsError(t *testing.T) {
	// A server that is closed immediately: the URL is well-formed but nothing is listening.
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	deadURL := srv.URL + "/.well-known/jwks.json"
	srv.Close()

	keyfn, err := middleware.LoadJWKS(context.Background(), deadURL)

	require.Error(t, err,
		"an unreachable JWKS must ERROR (it used to return nil, booting with an empty key set "+
			"that 401'd every request while /health reported 200)")
	assert.Nil(t, keyfn)
}

// A JWKS endpoint answering non-200 is the same outage wearing a different hat.
func TestLoadJWKS_ServerError_ReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	_, err := middleware.LoadJWKS(context.Background(), srv.URL)

	require.Error(t, err)
}

func TestLoadJWKS_ValidKeySet_LoadsAndReportsItsKeys(t *testing.T) {
	srv := newJWKSServer(t)

	keyfn, err := middleware.LoadJWKS(context.Background(), srv.URL)

	require.NoError(t, err)
	require.NotNil(t, keyfn)

	// /health reads this: zero keys means every authenticated request will 401, which must
	// never be reported as healthy.
	count, ok := middleware.JWKSKeyCount(context.Background())
	assert.True(t, ok, "the key set must report as initialised")
	assert.Equal(t, 1, count)
}
