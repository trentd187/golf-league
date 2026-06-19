// conn.go owns the per-connection WebSocket lifecycle for live score updates: the
// Fiber upgrade handler, the read/write pumps with heartbeat + deadlines, the
// supervised hub-run wrapper, and the disconnect-reason classifier.
//
// It lives in the websocket package (not handlers) deliberately: the socket pumps are
// I/O glue that can't be meaningfully unit-tested, and this package is excluded from
// both the Go coverage ratchet (-coverpkg) and SonarCloud coverage. The pure helpers
// here (classifyDisconnectReason, runGuarded) still have unit tests for correctness.
//
// Every goroutine carries its own defer sentry.Recover(): gofiber spawns the
// connection handler AFTER the upgrade, outside Fiber's recover middleware, so a panic
// here would otherwise crash the process. See backend/docs/websockets.md.
package websocket

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/getsentry/sentry-go"
	gofiberws "github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
)

// WebSocket heartbeat/timeout tuning. Documented in backend/docs/websockets.md.
// Named constants, not magic numbers — chosen for a flaky cellular link.
const (
	wsPingInterval = 30 * time.Second // how often the server pings to probe the link
	wsPongWait     = 45 * time.Second // read deadline; a missed pong past this reaps a dead phone
	wsWriteWait    = 10 * time.Second // bound a single stuck write
	wsSendBuffer   = 16               // per-client outbound buffer before the hub evicts a slow consumer
)

// RunHubSupervised runs the hub's broadcast loop and restarts it if it panics, so a
// single bad broadcast can't permanently kill live updates for every connected
// client. hub.Run() normally blocks forever; it only returns here after a recovered
// panic. Start it with `go RunHubSupervised(hub)`.
func RunHubSupervised(hub *Hub) {
	for {
		runGuarded(hub.Run)
	}
}

// runGuarded runs fn under a recover, reporting any panic to Sentry (ws.hub_panic)
// and returning true if it panicked. Separated from the restart loop so the
// recover/report path is unit-testable without a real, panicking hub loop.
func runGuarded(fn func()) (panicked bool) {
	defer func() {
		if r := recover(); r != nil {
			panicked = true
			sentry.CurrentHub().Recover(r)
			sentry.Flush(2 * time.Second)
			slog.Error("WebSocket hub panicked; restarting",
				"event_type_label", "ws.hub_panic",
				"panic", fmt.Sprintf("%v", r))
		}
	}()
	fn()
	return false
}

// ServeRoundWS returns the Fiber handler for GET /api/v1/ws/rounds/:roundId. The
// connection must already be authenticated by middleware.WSAuth (which set userID in
// Locals). Round membership is not required — a live-score subscription is read-only,
// matching the scorecard's public read.
func ServeRoundWS(hub *Hub) fiber.Handler {
	return gofiberws.New(func(conn *gofiberws.Conn) {
		// gofiber runs this in its own goroutine outside Fiber's recover middleware,
		// so a panic here would crash the process — capture it instead.
		defer sentry.Recover()

		roundID := conn.Params("roundId")
		userID, _ := conn.Locals("userID").(string)

		client := &Client{
			RoundID: roundID,
			Send:    make(chan []byte, wsSendBuffer),
		}
		hub.Register(client)
		defer hub.Unregister(client)

		slog.Info("WebSocket connected",
			"event_type_label", "ws.connected",
			"round_id", roundID, "user_id", userID, "conn_count", hub.ConnCount())

		// done coordinates the reader (this goroutine) and the writer goroutine so
		// neither leaks: whichever exits first closes done, stopping the other.
		done := make(chan struct{})
		var once sync.Once
		stop := func() { once.Do(func() { close(done) }) }

		go writePump(conn, client.Send, done, stop)

		reason := readPump(conn)
		stop()

		slog.Info("WebSocket disconnected",
			"event_type_label", "ws.disconnected",
			"round_id", roundID, "user_id", userID,
			"reason", reason, "conn_count", hub.ConnCount())
	})
}

// readPump blocks reading from the socket purely to detect a close and to drive the
// pong deadline (the client auto-responds to our pings at the protocol level). It
// returns a classified reason when the read fails. We don't expect client→server
// payloads, so any received message is ignored.
func readPump(conn *gofiberws.Conn) string {
	_ = conn.SetReadDeadline(time.Now().Add(wsPongWait))
	conn.SetPongHandler(func(string) error {
		// Each pong proves the link is alive — extend the read deadline.
		return conn.SetReadDeadline(time.Now().Add(wsPongWait))
	})
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return classifyDisconnectReason(err)
		}
	}
}

// writePump drains the client's Send channel to the socket and sends periodic pings.
// It exits when Send is closed (hub evicted/unregistered the client), on any write
// error, or when done is closed (the reader exited). Its deferred stop() unblocks the
// reader's coordination if the writer dies first.
func writePump(conn *gofiberws.Conn, send <-chan []byte, done <-chan struct{}, stop func()) {
	defer sentry.Recover()
	defer stop()

	ticker := time.NewTicker(wsPingInterval)
	defer ticker.Stop()

	for {
		select {
		case msg, ok := <-send:
			_ = conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
			if !ok {
				// Hub closed the channel — send a courteous close frame and stop.
				_ = conn.WriteMessage(gofiberws.CloseMessage,
					gofiberws.FormatCloseMessage(gofiberws.CloseNormalClosure, ""))
				return
			}
			if err := conn.WriteMessage(gofiberws.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
			if err := conn.WriteMessage(gofiberws.PingMessage, nil); err != nil {
				return
			}
		case <-done:
			return
		}
	}
}

// classifyDisconnectReason maps a read error to a stable label for the
// ws.disconnected log. Pure and dependency-free (stdlib only) so it's unit-testable:
//   - nil / a normal close frame → "client_close"
//   - a deadline/timeout (no pong within wsPongWait — the half-open cellular case) → "pong_timeout"
//   - anything else (reset, broken pipe, protocol error) → "read_error"
func classifyDisconnectReason(err error) string {
	if err == nil {
		return "client_close"
	}

	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "pong_timeout"
	}

	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline"):
		return "pong_timeout"
	case strings.Contains(msg, "1000") || strings.Contains(msg, "1001") ||
		strings.Contains(msg, "normal") || strings.Contains(msg, "going away"):
		return "client_close"
	default:
		return "read_error"
	}
}
