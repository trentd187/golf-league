// hub_test.go covers the Hub's register/broadcast/unregister lifecycle and the two
// resilience fixes: the deadlock-free slow-consumer eviction and the non-blocking
// BroadcastToRound. These run without a real socket — they exercise the channel/map
// machinery directly.
//
//	go test ./internal/websocket/ -run TestHub -v
package websocket

import (
	"testing"
	"time"
)

// waitForConn polls ConnCount until it reaches want or the deadline passes. Register
// and Unregister are processed asynchronously by the Run goroutine, so the count
// lags the call by a few microseconds — polling avoids a flaky fixed sleep.
func waitForConn(t *testing.T, h *Hub, want int32) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if h.ConnCount() == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("ConnCount did not reach %d (got %d)", want, h.ConnCount())
}

// TestHub_RegisterBroadcastUnregister is the happy path: a registered client receives
// a broadcast for its round, and unregistering closes its Send channel.
func TestHub_RegisterBroadcastUnregister(t *testing.T) {
	hub := NewHub()
	go hub.Run()

	client := &Client{RoundID: "r1", Send: make(chan []byte, 4)}
	hub.Register(client)
	waitForConn(t, hub, 1)

	hub.BroadcastToRound("r1", []byte("hello"))
	select {
	case msg := <-client.Send:
		if string(msg) != "hello" {
			t.Fatalf("got %q, want hello", msg)
		}
	case <-time.After(time.Second):
		t.Fatal("no broadcast received")
	}

	hub.Unregister(client)
	waitForConn(t, hub, 0)

	if _, ok := <-client.Send; ok {
		t.Fatal("Send channel should be closed after unregister")
	}
}

// TestHub_BroadcastOnlyToMatchingRound verifies a broadcast for one round never
// reaches a client watching a different round.
func TestHub_BroadcastOnlyToMatchingRound(t *testing.T) {
	hub := NewHub()
	go hub.Run()

	r1 := &Client{RoundID: "r1", Send: make(chan []byte, 4)}
	r2 := &Client{RoundID: "r2", Send: make(chan []byte, 4)}
	hub.Register(r1)
	hub.Register(r2)
	waitForConn(t, hub, 2)

	hub.BroadcastToRound("r1", []byte("x"))
	select {
	case <-r1.Send: // expected
	case <-time.After(time.Second):
		t.Fatal("r1 should have received the broadcast")
	}
	select {
	case <-r2.Send:
		t.Fatal("r2 must not receive r1's broadcast")
	case <-time.After(50 * time.Millisecond):
		// expected: nothing for r2
	}
}

// TestHub_SlowConsumerEvicted is the regression test for the self-deadlock bug: a
// client whose Send buffer is full is evicted from inside the broadcast path. With
// the old `h.unregister <- client` code this test would DEADLOCK and time out,
// because the unbuffered unregister channel is consumed by the very goroutine that
// would be blocked sending to it. ConnCount dropping to 0 proves the fix.
func TestHub_SlowConsumerEvicted(t *testing.T) {
	hub := NewHub()
	go hub.Run()

	// Buffer of 1, never drained: the first broadcast fills it, the second finds it
	// full and triggers eviction.
	client := &Client{RoundID: "r1", Send: make(chan []byte, 1)}
	hub.Register(client)
	waitForConn(t, hub, 1)

	hub.BroadcastToRound("r1", []byte("a")) // fills the buffer
	hub.BroadcastToRound("r1", []byte("b")) // buffer full → client evicted

	waitForConn(t, hub, 0) // no deadlock + eviction happened
}

// TestHub_BroadcastNonBlockingWhenFull verifies BroadcastToRound never blocks the
// caller even when the hub's broadcast buffer is saturated (Run not draining it).
// If it blocked, this test would hang and time out.
func TestHub_BroadcastNonBlockingWhenFull(t *testing.T) {
	hub := NewHub()
	// Intentionally do NOT start Run, so nothing drains the broadcast channel.
	done := make(chan struct{})
	go func() {
		// Far more than the 256 buffer — the overflow must be dropped, not block.
		for i := 0; i < 300; i++ {
			hub.BroadcastToRound("r1", []byte("x"))
		}
		close(done)
	}()

	select {
	case <-done:
		// success: all calls returned without blocking
	case <-time.After(2 * time.Second):
		t.Fatal("BroadcastToRound blocked when the buffer was full")
	}
}

// TestHub_ConnCountStartsZero is a trivial guard on the initial counter state.
func TestHub_ConnCountStartsZero(t *testing.T) {
	if got := NewHub().ConnCount(); got != 0 {
		t.Fatalf("new hub ConnCount = %d, want 0", got)
	}
}
