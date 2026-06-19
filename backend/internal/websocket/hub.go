// Package websocket implements a WebSocket Hub for broadcasting real-time score updates.
// WebSockets are persistent two-way connections — the server can push data to clients
// instantly without polling. Used so players watching a live round see score updates
// the moment they're entered.
package websocket

import (
	"log/slog"    // slog emits the drop/eviction signals; the default logger fans out to Sentry Logs
	"sync"        // sync provides the RWMutex for safe concurrent map access
	"sync/atomic" // atomic provides lock-free integer operations for the connection counter
)

// Client represents a single connected WebSocket client.
type Client struct {
	RoundID string      // Which round this client is watching
	Send    chan []byte // Buffered channel of outgoing messages
}

// Message is a unit of data to broadcast to all clients watching a specific round.
type Message struct {
	RoundID string
	Data    []byte // Typically JSON-encoded score data
}

// Hub manages all active WebSocket connections, grouped by round ID.
// It runs in its own goroutine and processes events through channels — keeping all
// map access on a single goroutine avoids data races (concurrent map reads/writes panic in Go).
type Hub struct {
	// clients is a nested map: roundID → set of Client pointers.
	// map[*Client]bool as a "set" is a common Go idiom — no built-in set type exists.
	clients map[string]map[*Client]bool

	broadcast  chan *Message
	register   chan *Client
	unregister chan *Client

	// RWMutex allows multiple concurrent readers (broadcast) or one exclusive writer (register/unregister).
	mu sync.RWMutex

	// connCount tracks the total number of active WebSocket connections.
	// Accessed via atomic operations so it can be read from any goroutine without holding mu.
	connCount int32
}

// NewHub creates and initializes a Hub.
// broadcast is buffered (256) so writers don't block immediately if the Hub goroutine is busy.
// register and unregister are unbuffered — those operations complete synchronously.
func NewHub() *Hub {
	return &Hub{
		clients:    make(map[string]map[*Client]bool),
		broadcast:  make(chan *Message, 256),
		register:   make(chan *Client),
		unregister: make(chan *Client),
	}
}

// Run is the Hub's main event loop. Must be called in a goroutine ("go hub.Run()").
// select blocks until one of the cases has data ready — like a switch but for channels.
func (h *Hub) Run() {
	for {
		select {

		case client := <-h.register:
			h.mu.Lock()
			if h.clients[client.RoundID] == nil {
				h.clients[client.RoundID] = make(map[*Client]bool)
			}
			h.clients[client.RoundID][client] = true
			h.mu.Unlock()
			atomic.AddInt32(&h.connCount, 1)

		case client := <-h.unregister:
			h.removeClient(client)

		case msg := <-h.broadcast:
			// Snapshot the round's clients under RLock, then release before sending so a
			// slow send never holds the map lock. We're only reading the map here.
			h.mu.RLock()
			targets := make([]*Client, 0, len(h.clients[msg.RoundID]))
			for client := range h.clients[msg.RoundID] {
				targets = append(targets, client)
			}
			h.mu.RUnlock()

			var slow []*Client
			for _, client := range targets {
				select {
				case client.Send <- msg.Data:
				// Full buffer = the client is too slow. The default case keeps this
				// non-blocking so one stuck client can't stall the others.
				default:
					slow = append(slow, client)
				}
			}

			// Evict slow clients AFTER the send loop. Doing this inline (via removeClient)
			// instead of `h.unregister <- client` is the deadlock fix: unregister is
			// unbuffered and consumed only by this same goroutine, so sending to it from
			// inside this case would block the Hub forever and freeze all broadcasts.
			for _, client := range slow {
				slog.Warn("WebSocket client dropped: send buffer full",
					"event_type_label", "ws.send_dropped", "round_id", msg.RoundID)
				h.removeClient(client)
			}
		}
	}
}

// removeClient unregisters a single client: deletes it from its round set, closes its
// Send channel (signalling the writer goroutine to stop), and decrements the counter.
// Idempotent — a second call for an already-removed client is a no-op, so the broadcast
// slow-consumer path and the connection's own deferred Unregister can't double-close.
// Only called from the Hub's Run goroutine, so the map is never touched concurrently.
func (h *Hub) removeClient(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	clients, ok := h.clients[client.RoundID]
	if !ok {
		return
	}
	if _, ok := clients[client]; !ok {
		return
	}
	delete(clients, client)
	close(client.Send)
	if len(clients) == 0 {
		delete(h.clients, client.RoundID)
	}
	atomic.AddInt32(&h.connCount, -1)
}

// BroadcastToRound sends data to all clients currently watching the given round.
// Called by handlers when a score is submitted.
//
// Non-blocking: if the broadcast buffer is full (the Hub goroutine is momentarily
// behind) the message is dropped rather than stalling the calling HTTP handler — a
// dropped live update is harmless because clients still have the 60s scorecard poll
// as a floor. A drop is logged so a saturated hub is visible, not silent.
func (h *Hub) BroadcastToRound(roundID string, data []byte) {
	select {
	case h.broadcast <- &Message{RoundID: roundID, Data: data}:
	default:
		slog.Warn("WebSocket broadcast dropped: hub buffer full",
			"event_type_label", "ws.broadcast_dropped", "round_id", roundID)
	}
}

// Register adds a client to the Hub so it starts receiving broadcasts for its round.
func (h *Hub) Register(client *Client) {
	h.register <- client
}

// Unregister removes a client from the Hub when its WebSocket connection closes.
func (h *Hub) Unregister(client *Client) {
	h.unregister <- client
}

// ConnCount returns the current number of active WebSocket connections.
// Safe to call from any goroutine — uses an atomic load, no lock needed.
func (h *Hub) ConnCount() int32 {
	return atomic.LoadInt32(&h.connCount)
}
