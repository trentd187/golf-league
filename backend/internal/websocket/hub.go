// Package websocket implements a WebSocket Hub for broadcasting real-time score updates.
// WebSockets are persistent two-way connections — the server can push data to clients
// instantly without polling. Used so players watching a live round see score updates
// the moment they're entered.
package websocket

import "sync" // sync provides the RWMutex for safe concurrent map access

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

		case client := <-h.unregister:
			h.mu.Lock()
			if clients, ok := h.clients[client.RoundID]; ok {
				if _, ok := clients[client]; ok {
					delete(clients, client)
					close(client.Send) // Closing the channel signals the WebSocket writer goroutine to stop
					if len(clients) == 0 {
						delete(h.clients, client.RoundID)
					}
				}
			}
			h.mu.Unlock()

		case msg := <-h.broadcast:
			// RLock: we're only reading the clients map, not modifying it.
			h.mu.RLock()
			clients := h.clients[msg.RoundID]
			h.mu.RUnlock()

			for client := range clients {
				select {
				case client.Send <- msg.Data:
				// If the channel buffer is full, the client is too slow — drop and disconnect.
				// The default case makes this non-blocking so we don't stall all other clients.
				default:
					h.unregister <- client
				}
			}
		}
	}
}

// BroadcastToRound sends data to all clients currently watching the given round.
// Called by handlers when a score is submitted.
func (h *Hub) BroadcastToRound(roundID string, data []byte) {
	h.broadcast <- &Message{RoundID: roundID, Data: data}
}

// Register adds a client to the Hub so it starts receiving broadcasts for its round.
func (h *Hub) Register(client *Client) {
	h.register <- client
}

// Unregister removes a client from the Hub when its WebSocket connection closes.
func (h *Hub) Unregister(client *Client) {
	h.unregister <- client
}
