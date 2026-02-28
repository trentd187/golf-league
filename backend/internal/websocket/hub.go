// Package websocket implements a WebSocket Hub for broadcasting real-time score updates.
// WebSockets are persistent two-way connections between the server and clients — unlike
// regular HTTP where the client always initiates the request, WebSockets let the server
// push data to clients instantly. This is used so players watching a live round see
// score updates the moment they're entered, without polling the API repeatedly.
package websocket

import "sync" // sync provides synchronization primitives like mutexes for safe concurrent access

// Client represents a single connected WebSocket client.
// Each player watching a live round has one Client instance on the server.
type Client struct {
	RoundID string     // Which round this client is watching — used to route messages to the right audience
	Send    chan []byte // Buffered channel of outgoing messages; the Hub sends data here, the WebSocket writes it to the client
}

// Message is a unit of data to broadcast to all clients watching a specific round.
// By attaching the RoundID, the Hub knows which group of clients should receive it.
type Message struct {
	RoundID string // The round this message belongs to
	Data    []byte // The raw bytes to send (typically JSON-encoded score data)
}

// Hub manages all active WebSocket connections, grouped by round ID.
// It runs in its own goroutine and processes registration, unregistration, and
// broadcast events through channels — this keeps all map access on a single goroutine,
// which avoids data races (concurrent map reads/writes cause panics in Go).
type Hub struct {
	// clients is a nested map: roundID -> set of Client pointers -> bool (true = connected).
	// Using a map[*Client]bool as a "set" is a common Go idiom because Go has no built-in set type.
	clients map[string]map[*Client]bool

	broadcast  chan *Message // Incoming messages to be sent to all clients watching a given round
	register   chan *Client  // Signals that a new client has connected and should be tracked
	unregister chan *Client  // Signals that a client has disconnected and should be removed

	// mu (mutex) protects the clients map when it's accessed from broadcast (RLock/RUnlock)
	// while the main loop modifies it (Lock/Unlock). A RWMutex allows multiple concurrent
	// readers OR one exclusive writer — suitable since broadcasts just read the client list.
	mu sync.RWMutex
}

// NewHub creates and initializes a Hub with empty channels and maps.
// The broadcast channel has a buffer of 256 so writers don't block immediately
// if the Hub goroutine is briefly busy. register and unregister are unbuffered
// because those operations need to complete synchronously.
func NewHub() *Hub {
	return &Hub{
		clients:    make(map[string]map[*Client]bool),
		broadcast:  make(chan *Message, 256),
		register:   make(chan *Client),
		unregister: make(chan *Client),
	}
}

// Run is the Hub's main event loop. It must be called in a goroutine ("go hub.Run()").
// It blocks forever, processing one event at a time via a select statement.
// select is like a switch but for channels — it waits until one of the cases has data ready.
func (h *Hub) Run() {
	for {
		select {

		// A new client has connected — add it to the clients map under its RoundID
		case client := <-h.register:
			h.mu.Lock()
			// If this is the first client for this round, initialize the inner map
			if h.clients[client.RoundID] == nil {
				h.clients[client.RoundID] = make(map[*Client]bool)
			}
			h.clients[client.RoundID][client] = true
			h.mu.Unlock()

		// A client has disconnected — remove it from the map and close its Send channel
		case client := <-h.unregister:
			h.mu.Lock()
			if clients, ok := h.clients[client.RoundID]; ok {
				if _, ok := clients[client]; ok {
					delete(clients, client)   // Remove this client from the round's set
					close(client.Send)        // Closing the channel signals the WebSocket writer goroutine to stop
					// Clean up the round's map entry if no clients are left — avoids memory leaks
					if len(clients) == 0 {
						delete(h.clients, client.RoundID)
					}
				}
			}
			h.mu.Unlock()

		// A message arrived to broadcast to all clients watching a specific round
		case msg := <-h.broadcast:
			// Use RLock (read lock) here because we're only reading the clients map,
			// not modifying it. Multiple goroutines can hold an RLock simultaneously.
			h.mu.RLock()
			clients := h.clients[msg.RoundID]
			h.mu.RUnlock()

			for client := range clients {
				select {
				// Try to send the message to the client's outgoing channel
				case client.Send <- msg.Data:
				// If the channel buffer is full, the client is too slow — drop and disconnect it.
				// The default case makes this non-blocking: if Send is full we unregister
				// rather than blocking the broadcast loop for all other clients.
				default:
					h.unregister <- client
				}
			}
		}
	}
}

// BroadcastToRound sends data to all clients currently watching the given round.
// This is the public API that handlers call when a score is submitted.
func (h *Hub) BroadcastToRound(roundID string, data []byte) {
	h.broadcast <- &Message{RoundID: roundID, Data: data}
}

// Register adds a client to the Hub so it starts receiving broadcasts for its round.
// Called when a WebSocket connection is opened.
func (h *Hub) Register(client *Client) {
	h.register <- client
}

// Unregister removes a client from the Hub when its WebSocket connection closes.
func (h *Hub) Unregister(client *Client) {
	h.unregister <- client
}
