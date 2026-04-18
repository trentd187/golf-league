// Package observability wires up the full Grafana Cloud telemetry stack:
// structured logging (Loki), metrics (Mimir via OTLP), traces (Tempo via OTLP),
// and continuous profiling (Pyroscope). Each pillar degrades gracefully to a
// no-op when its env vars are not set — the server runs normally without them.
package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"
)

// lokiEntry is a single log line queued for batch delivery to Loki.
type lokiEntry struct {
	level   slog.Level
	ts      time.Time
	message string
	attrs   []slog.Attr
}

// LokiHandler writes structured logs to stdout (always) and pushes them to
// Grafana Cloud Loki in batches (when configured). It implements the LokiPusher
// interface used by the telemetry handler for proxying mobile logs.
type LokiHandler struct {
	stdout   *slog.Logger // JSON handler writing to os.Stdout — always active
	lokiURL  string
	lokiUser string
	lokiKey  string
	env      string
	minLevel slog.Level

	// ch receives log entries from callers; the background goroutine drains it.
	ch   chan lokiEntry
	wg   sync.WaitGroup
	once sync.Once // ensures Shutdown is idempotent
}

// NewLokiHandler creates a LokiHandler. Loki push is disabled when any of url,
// user, or apiKey is empty — stdout JSON logging is always active at minLevel.
func NewLokiHandler(url, user, apiKey, env string, minLevel slog.Level) *LokiHandler {
	h := &LokiHandler{
		stdout:   slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: minLevel})),
		lokiURL:  url,
		lokiUser: user,
		lokiKey:  apiKey,
		env:      env,
		minLevel: minLevel,
		ch:       make(chan lokiEntry, 512),
	}

	if url != "" && user != "" && apiKey != "" {
		h.wg.Add(1)
		go h.runFlusher()
	}

	return h
}

// Log writes a structured log entry. It always writes to stdout and, when Loki
// is configured and the level meets the minimum threshold, enqueues for push.
// The level label is included in the Loki stream so entries can be filtered by
// level in Grafana Explore.
func (h *LokiHandler) Log(ctx context.Context, level slog.Level, msg string, args ...any) {
	// Build attrs from key-value args so they appear in both stdout and Loki.
	attrs := argsToAttrs(args)

	// Always write to stdout — this is the primary dev/ops log stream.
	r := slog.NewRecord(time.Now(), level, msg, 0)
	r.AddAttrs(attrs...)
	_ = h.stdout.Handler().Handle(ctx, r)

	// Enqueue for Loki only when configured and at or above the minimum level.
	if h.lokiURL == "" || level < h.minLevel {
		return
	}

	entry := lokiEntry{level: level, ts: time.Now(), message: msg, attrs: attrs}
	select {
	case h.ch <- entry:
	default:
		// Channel full — drop silently to stay within free-tier Loki budget.
	}
}

// Shutdown drains the queue and waits for the background flusher to finish.
// Safe to call multiple times.
func (h *LokiHandler) Shutdown() {
	h.once.Do(func() {
		close(h.ch)
		h.wg.Wait()
	})
}

// runFlusher is the background goroutine that batches and pushes entries to Loki.
// It flushes every 5 seconds or when 50 entries accumulate, whichever comes first.
func (h *LokiHandler) runFlusher() {
	defer h.wg.Done()

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	var batch []lokiEntry

	flush := func() {
		if len(batch) == 0 {
			return
		}
		h.pushToLoki(batch)
		batch = batch[:0]
	}

	for {
		select {
		case entry, ok := <-h.ch:
			if !ok {
				flush()
				return
			}
			batch = append(batch, entry)
			if len(batch) >= 50 {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}

// lokiPushPayload is the JSON body expected by the Loki push API.
type lokiPushPayload struct {
	Streams []lokiStream `json:"streams"`
}

type lokiStream struct {
	Stream map[string]string `json:"stream"`
	Values [][2]string       `json:"values"` // [unix_nano_string, log_line]
}

// streamKey groups Loki entries into separate streams.
// Loki stream labels are indexed — one stream per (level, service, env) triple.
type streamKey struct {
	level   string
	service string // "backend" or "mobile"
	env     string
}

// pushToLoki serialises a batch of entries into Loki's push format and sends
// one HTTP request per stream group. Each (level, service, env) triple gets its
// own stream so callers can filter by {service="backend"} or {service="mobile",env="production"}.
//
// For backend entries the env label is always h.env (from the ENV env var).
// For mobile entries the env label is taken from the "env" field sent by the
// mobile app — "development" in Expo Go / dev client, "production" in EAS builds.
// Errors are printed to stderr to avoid recursive logging.
func (h *LokiHandler) pushToLoki(batch []lokiEntry) {
	// Group entries by (level, service, env).
	// Mobile entries are identified by source="mobile" in their attrs — set by
	// the telemetry handler when proxying logs from the React Native app.
	byStream := make(map[streamKey][]lokiEntry)
	for _, e := range batch {
		svc := "backend"
		env := h.env
		for _, a := range e.attrs {
			if a.Key == "source" && a.Value.String() == "mobile" {
				svc = "mobile"
			}
			// Use the mobile app's own env field so dev and prod builds are
			// distinguishable even when routed through the same backend instance.
			if svc == "mobile" && a.Key == "env" && a.Value.String() != "" {
				env = a.Value.String()
			}
		}
		key := streamKey{level: levelLabel(e.level), service: svc, env: env}
		byStream[key] = append(byStream[key], e)
	}

	var streams []lokiStream
	for key, entries := range byStream {
		stream := lokiStream{
			Stream: map[string]string{
				"service": key.service,
				"env":     key.env,
				"level":   key.level,
			},
		}
		for _, e := range entries {
			line, err := entryToJSON(e)
			if err != nil {
				continue
			}
			nanoStr := fmt.Sprintf("%d", e.ts.UnixNano())
			stream.Values = append(stream.Values, [2]string{nanoStr, line})
		}
		streams = append(streams, stream)
	}

	payload := lokiPushPayload{Streams: streams}
	body, err := json.Marshal(payload)
	if err != nil {
		fmt.Fprintf(os.Stderr, "observability: loki marshal error: %v\n", err)
		return
	}

	//nolint:gosec // h.lokiURL is operator-configured, not user input
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, h.lokiURL, bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "observability: loki request build error: %v\n", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.SetBasicAuth(h.lokiUser, h.lokiKey)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "observability: loki push error: %v\n", err)
		return
	}
	defer func() { _ = resp.Body.Close() }()
}

// entryToJSON serialises a lokiEntry to a compact JSON string for the Loki value field.
func entryToJSON(e lokiEntry) (string, error) {
	m := make(map[string]any, len(e.attrs)+2)
	m["level"] = levelLabel(e.level)
	m["msg"] = e.message
	for _, a := range e.attrs {
		m[a.Key] = a.Value.Any()
	}
	b, err := json.Marshal(m)
	return string(b), err
}

// levelLabel converts a slog.Level to the lowercase string used in Loki stream labels.
func levelLabel(l slog.Level) string {
	switch {
	case l >= slog.LevelError:
		return "error"
	case l >= slog.LevelWarn:
		return "warn"
	case l >= slog.LevelInfo:
		return "info"
	default:
		return "debug"
	}
}

// argsToAttrs converts key-value pairs (as passed to slog) into typed slog.Attr values.
// Keys without a matching value are paired with the string "<missing>".
func argsToAttrs(args []any) []slog.Attr {
	var attrs []slog.Attr
	for i := 0; i < len(args); i += 2 {
		key, ok := args[i].(string)
		if !ok {
			continue
		}
		if i+1 >= len(args) {
			attrs = append(attrs, slog.String(key, "<missing>"))
			continue
		}
		attrs = append(attrs, slog.Any(key, args[i+1]))
	}
	return attrs
}
