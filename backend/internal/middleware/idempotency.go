// Package middleware contains HTTP middleware functions for the Golf League API.
// This file detects retried (replayed) idempotent writes via the Idempotency-Key
// header and records them as an observability signal.
package middleware

// idempotency.go — Idempotency-Key replay detection.
//
// The cellular "phantom save" failure mode is a write that commits server-side while
// the last-mile response is lost, so the client retries. The score PUT is an
// idempotent upsert, so a replayed write is harmless — but until now it was also
// invisible: there was no server-side count of how often retries actually land on an
// already-committed write. The mobile client now sends a stable Idempotency-Key per
// logical save (reused across its internal retries), so a second request bearing a
// key we have already seen IS direct evidence of a last-mile response loss.
//
// This middleware DETECTS and LOGS those replays (event_type_label:score.idempotent_replay)
// — it deliberately does not block or response-cache, because the endpoint is already
// idempotent and re-running the upsert is correct. The store is best-effort in-memory:
// it survives neither a restart nor multiple instances, which is fine for a metric but
// is why a *durable* dedupe store is still required before any non-idempotent POST
// create is allowed to retry. See project memory feedback-idempotent-retry-rule.

import (
	"log/slog"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
)

// idempotencyTTL is how long a key is remembered. A few minutes comfortably covers a
// client's full retry/backoff budget (BACKGROUND_SAVE tops out well under a minute)
// while bounding memory. evictThreshold caps the map so a burst can't grow it forever.
const (
	idempotencyTTL = 10 * time.Minute
	evictThreshold = 10000
)

// IdempotencyStore is a TTL-bounded set of recently-seen keys. Concurrency-safe; all
// access goes through the mutex. Exposed (with the constructor) so tests can inject a
// clock and assert eviction without sleeping.
type IdempotencyStore struct {
	mu   sync.Mutex
	seen map[string]time.Time
	ttl  time.Duration
	now  func() time.Time // injectable clock for tests
}

// NewIdempotencyStore builds an empty store with the default TTL and the real clock.
func NewIdempotencyStore() *IdempotencyStore {
	return &IdempotencyStore{seen: make(map[string]time.Time), ttl: idempotencyTTL, now: time.Now}
}

// SetClockForTest swaps the store's clock so TTL expiry can be exercised
// deterministically without sleeping. Test-only.
func (s *IdempotencyStore) SetClockForTest(now func() time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.now = now
}

// Observe records key and reports whether it was already present (and unexpired) —
// i.e. whether this is a replay. Expired entries are treated as absent. It opportunistically
// evicts expired keys when the map grows past evictThreshold so memory stays bounded.
func (s *IdempotencyStore) Observe(key string) bool {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()

	prev, ok := s.seen[key]
	replay := ok && now.Sub(prev) < s.ttl

	if len(s.seen) > evictThreshold {
		for k, t := range s.seen {
			if now.Sub(t) >= s.ttl {
				delete(s.seen, k)
			}
		}
	}

	s.seen[key] = now
	return replay
}

// IdempotencyReplayLog returns middleware that, when a request carries an
// Idempotency-Key already seen within the TTL, emits a replay log. It never blocks
// the request — detection only. Apply to idempotent write routes (e.g. the score PUT).
func IdempotencyReplayLog(store *IdempotencyStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		key := c.Get("Idempotency-Key")
		if key != "" && store.Observe(key) {
			slog.InfoContext(c.UserContext(), "Idempotent write replayed — prior attempt likely committed before the client retried",
				"event_type_label", "score.idempotent_replay",
				"method", c.Method(),
				"path", c.Path(),
				"idempotency_key", key,
			)
		}
		return c.Next()
	}
}
