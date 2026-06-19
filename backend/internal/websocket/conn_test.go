// conn_test.go covers the pure, dependency-free helpers in conn.go: the
// disconnect-reason classifier (which labels the ws.disconnected log) and the
// supervised-run guard (which reports + recovers a hub panic). The socket pumps
// themselves are I/O glue and aren't unit-tested.
//
//	go test ./internal/websocket/ -run "TestClassifyDisconnectReason|TestRunGuarded" -v
package websocket

import (
	"errors"
	"testing"
)

// timeoutNetError implements net.Error with Timeout() true and a message that does
// NOT contain "timeout"/"deadline", so the test proves the net.Error branch — not the
// string fallback — classifies it as pong_timeout.
type timeoutNetError struct{}

func (timeoutNetError) Error() string   { return "boom" }
func (timeoutNetError) Timeout() bool   { return true }
func (timeoutNetError) Temporary() bool { return true }

func TestClassifyDisconnectReason(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"nil is a clean client close", nil, "client_close"},
		{"net.Error timeout via interface", timeoutNetError{}, "pong_timeout"},
		{"i/o timeout string", errors.New("read tcp: i/o timeout"), "pong_timeout"},
		{"deadline string", errors.New("write: deadline exceeded"), "pong_timeout"},
		{"normal close 1000", errors.New("websocket: close 1000 (normal)"), "client_close"},
		{"going away 1001", errors.New("websocket: close 1001 (going away)"), "client_close"},
		{"reset is a read error", errors.New("connection reset by peer"), "read_error"},
		{"broken pipe is a read error", errors.New("write: broken pipe"), "read_error"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyDisconnectReason(tc.err); got != tc.want {
				t.Errorf("classifyDisconnectReason(%v) = %q, want %q", tc.err, got, tc.want)
			}
		})
	}
}

// TestRunGuarded verifies the supervised-run guard recovers a panic (returning true)
// and returns false on a normal completion — the behavior RunHubSupervised relies on
// to restart the hub loop after a panic instead of crashing the process.
func TestRunGuarded(t *testing.T) {
	if runGuarded(func() {}) {
		t.Error("runGuarded(normal) = true, want false")
	}

	ran := false
	panicked := runGuarded(func() {
		ran = true
		panic("simulated hub panic")
	})
	if !ran {
		t.Error("fn was not executed")
	}
	if !panicked {
		t.Error("runGuarded(panic) = false, want true")
	}
}
