// scores_broadcast_internal_test.go is an internal (package handlers) test for the
// unexported broadcastScoresUpdated helper that the score handlers call after a
// successful save. It verifies the live-update message shape and the best-effort
// nil-broadcaster guard without needing a real hub or DB.
//
//	go test ./internal/handlers/ -run TestBroadcastScoresUpdated -v
package handlers

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

// fakeBroadcaster records the last BroadcastToRound call so the test can assert the
// round id and payload the handler would push to WebSocket subscribers.
type fakeBroadcaster struct {
	calls   int
	roundID string
	data    []byte
}

func (f *fakeBroadcaster) BroadcastToRound(roundID string, data []byte) {
	f.calls++
	f.roundID = roundID
	f.data = data
}

func TestBroadcastScoresUpdated_SendsMessage(t *testing.T) {
	bc := &fakeBroadcaster{}
	roundID := uuid.New()

	broadcastScoresUpdated(bc, roundID)

	if bc.calls != 1 {
		t.Fatalf("BroadcastToRound called %d times, want 1", bc.calls)
	}
	if bc.roundID != roundID.String() {
		t.Errorf("round id = %q, want %q", bc.roundID, roundID.String())
	}

	var msg liveScoreMessage
	if err := json.Unmarshal(bc.data, &msg); err != nil {
		t.Fatalf("payload is not valid JSON: %v", err)
	}
	if msg.Type != "scores_updated" {
		t.Errorf("type = %q, want scores_updated", msg.Type)
	}
	if msg.RoundID != roundID.String() {
		t.Errorf("payload round_id = %q, want %q", msg.RoundID, roundID.String())
	}
}

// TestBroadcastScoresUpdated_NilBroadcaster confirms the best-effort guard: a nil
// Broadcaster (tests, or a build without the hub wired) is a no-op, never a panic.
func TestBroadcastScoresUpdated_NilBroadcaster(t *testing.T) {
	// Must not panic.
	broadcastScoresUpdated(nil, uuid.New())
}
