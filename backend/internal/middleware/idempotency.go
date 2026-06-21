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
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/trentd187/golf-league/internal/models"
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

// ─── Durable store + middleware (non-idempotent POST creates) ───────────────────
//
// The store above is in-memory, detection-only, and re-runs the (idempotent) PUT, so
// it can't protect a non-idempotent POST: a cellular retry of a create that already
// committed would insert a SECOND row. DurableIdempotencyStore + Idempotency below
// close that gap — they persist each create keyed by Idempotency-Key in Postgres
// (migration 000024) and REPLAY the original response on a repeat instead of
// re-creating. Durable means it survives a Railway restart and is shared across
// replicas, which the in-memory map is not. See project memory
// feedback-idempotent-retry-rule and project-cellular-phantom-saves.

const (
	// durableIdempotencyTTL bounds how long a create's response stays replayable. A day
	// comfortably covers any client retry while keeping the table small.
	durableIdempotencyTTL = 24 * time.Hour
	// cleanupInterval throttles the expired-row sweep so a hot create path runs the
	// DELETE at most once per interval regardless of request volume.
	cleanupInterval = 5 * time.Minute
)

// IdempotencyRecord is the subset of a stored key the middleware inspects on a repeat.
// A nil ResponseStatus means the original request is still in flight.
type IdempotencyRecord struct {
	UserID         uuid.UUID
	RequestHash    string
	ResponseStatus *int
	ResponseBody   *string
}

// DurableIdempotencyStore reserves, replays, and releases create keys in Postgres. All
// key state lives in the DB (shared across replicas); mu/lastCleanup only throttle the
// expired-row sweep, and now is an injectable clock for tests.
type DurableIdempotencyStore struct {
	db          *gorm.DB
	ttl         time.Duration
	now         func() time.Time
	mu          sync.Mutex
	lastCleanup time.Time
}

// NewDurableIdempotencyStore builds a store over db with the default TTL and real clock.
func NewDurableIdempotencyStore(db *gorm.DB) *DurableIdempotencyStore {
	return &DurableIdempotencyStore{db: db, ttl: durableIdempotencyTTL, now: time.Now}
}

// SetDurableClockForTest swaps the store clock so TTL/expiry and the cleanup throttle
// can be exercised deterministically without sleeping. Test-only.
func (s *DurableIdempotencyStore) SetDurableClockForTest(now func() time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.now = now
}

// Claim reserves key for this request. It returns (nil, true, nil) when this caller is
// the original — proceed, then call Store. It returns (record, false, nil) when the key
// already exists (a retry): the caller inspects the record to replay, reject, or wait.
// An expired row is reclaimable: it is deleted and the claim retried once.
func (s *DurableIdempotencyStore) Claim(
	ctx context.Context, key string, userID uuid.UUID, method, path, hash string,
) (*IdempotencyRecord, bool, error) {
	row := models.IdempotencyKey{
		Key:         key,
		UserID:      userID,
		Method:      method,
		Path:        path,
		RequestHash: hash,
		ExpiresAt:   s.now().Add(s.ttl),
	}
	// INSERT ... ON CONFLICT DO NOTHING is the atomic claim: exactly one concurrent
	// request inserts the row (RowsAffected 1); the rest see 0 and read it back.
	res := s.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(&row)
	if res.Error != nil {
		return nil, false, res.Error
	}
	if res.RowsAffected == 1 {
		s.maybeCleanup(ctx)
		return nil, true, nil
	}

	var existing models.IdempotencyKey
	if err := s.db.WithContext(ctx).Where("key = ?", key).First(&existing).Error; err != nil {
		return nil, false, err
	}
	// An expired row no longer protects anything — reclaim it so the key can be reused.
	if s.now().After(existing.ExpiresAt) {
		if err := s.db.WithContext(ctx).Where("key = ?", key).Delete(&models.IdempotencyKey{}).Error; err != nil {
			return nil, false, err
		}
		return s.Claim(ctx, key, userID, method, path, hash)
	}
	return &IdempotencyRecord{
		UserID:         existing.UserID,
		RequestHash:    existing.RequestHash,
		ResponseStatus: existing.ResponseStatus,
		ResponseBody:   existing.ResponseBody,
	}, false, nil
}

// Store records the original's response so later retries replay it. Called only after
// a 2xx — a non-2xx is released instead, so a genuine failure retries fresh.
func (s *DurableIdempotencyStore) Store(ctx context.Context, key string, status int, body string) error {
	return s.db.WithContext(ctx).Model(&models.IdempotencyKey{}).
		Where("key = ?", key).
		Updates(map[string]any{"response_status": status, "response_body": body}).Error
}

// Release drops a claimed key whose request did not succeed, so the client's retry is
// processed fresh rather than waiting on (or replaying) a failed attempt.
func (s *DurableIdempotencyStore) Release(ctx context.Context, key string) error {
	return s.db.WithContext(ctx).Where("key = ?", key).Delete(&models.IdempotencyKey{}).Error
}

// maybeCleanup deletes expired rows at most once per cleanupInterval. Throttled so a
// burst of creates doesn't run the sweep on every request; best-effort (a failed sweep
// just leaves rows to be collected on the next pass).
func (s *DurableIdempotencyStore) maybeCleanup(ctx context.Context) {
	now := s.now()
	s.mu.Lock()
	if !s.lastCleanup.IsZero() && now.Sub(s.lastCleanup) < cleanupInterval {
		s.mu.Unlock()
		return
	}
	s.lastCleanup = now
	s.mu.Unlock()
	s.db.WithContext(ctx).Where("expires_at < ?", now).Delete(&models.IdempotencyKey{})
}

// RequestFingerprint hashes the parts of a request that must match for a replay to be
// valid. A key reused with a different body is a client bug, surfaced as 422. Exported
// so callers/tests can reproduce the exact fingerprint the middleware computes.
func RequestFingerprint(method, path string, body []byte) string {
	h := sha256.New()
	h.Write([]byte(method))
	h.Write([]byte{'\n'})
	h.Write([]byte(path))
	h.Write([]byte{'\n'})
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

// Idempotency returns middleware that makes the non-idempotent POST create it wraps
// safe to retry: a repeat bearing an Idempotency-Key already committed replays the
// stored response instead of creating a duplicate row. Apply to create routes only;
// idempotent PUTs use the lighter IdempotencyReplayLog above.
//
// Keyless requests pass through unchanged (back-compat: an older client that doesn't
// send the header simply isn't deduped). A store error never blocks the create — it
// degrades to processing without dedupe and reports the failure, because a silent
// swallow would hide a real outage.
func Idempotency(store *DurableIdempotencyStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		key := c.Get("Idempotency-Key")
		if key == "" {
			return c.Next()
		}
		userIDStr, _ := c.Locals("userID").(string)
		userID, err := uuid.Parse(userIDStr)
		if err != nil {
			// No / invalid auth context — let the route's own auth handling respond.
			return c.Next()
		}

		hash := RequestFingerprint(c.Method(), c.Path(), c.Body())
		existing, claimed, err := store.Claim(c.UserContext(), key, userID, c.Method(), c.Path(), hash)
		if err != nil {
			slog.ErrorContext(c.UserContext(), "Idempotency store claim failed; processing create without dedupe",
				"event_type_label", "create.idempotency_store_error",
				"method", c.Method(), "path", c.Path(), "error", err.Error())
			return c.Next()
		}

		if !claimed {
			switch {
			case existing.UserID != userID:
				// Key minted by (or leaked to) a different caller — refuse to act on it.
				return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "idempotency key already used"})
			case existing.RequestHash != hash:
				return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"error": "idempotency key reused with a different request"})
			case existing.ResponseStatus == nil:
				// Original still in flight (the retry overlapped a slow first attempt).
				// Tell the client to back off; its retry budget covers the wait.
				return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "request already in progress; retry shortly"})
			}
			slog.InfoContext(c.UserContext(), "Idempotent create replayed — prior attempt committed before the client retried",
				"event_type_label", "create.idempotent_replay",
				"method", c.Method(), "path", c.Path(), "idempotency_key", key)
			c.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
			c.Set("Idempotent-Replay", "true")
			body := ""
			if existing.ResponseBody != nil {
				body = *existing.ResponseBody
			}
			return c.Status(*existing.ResponseStatus).SendString(body)
		}

		// We own the key: run the handler, then capture its response on success or
		// release the claim on failure so a real error can be retried fresh.
		nextErr := c.Next()
		status := c.Response().StatusCode()
		if nextErr == nil && status >= 200 && status < 300 {
			if err := store.Store(c.UserContext(), key, status, string(c.Response().Body())); err != nil {
				slog.ErrorContext(c.UserContext(), "Idempotency store save failed; a retry may re-create",
					"event_type_label", "create.idempotency_store_error",
					"method", c.Method(), "path", c.Path(), "error", err.Error())
			}
		} else if relErr := store.Release(c.UserContext(), key); relErr != nil {
			slog.ErrorContext(c.UserContext(), "Idempotency store release failed",
				"event_type_label", "create.idempotency_store_error",
				"method", c.Method(), "path", c.Path(), "error", relErr.Error())
		}
		return nextErr
	}
}
