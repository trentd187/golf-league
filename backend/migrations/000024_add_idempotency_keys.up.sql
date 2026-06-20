-- 000024_add_idempotency_keys.up.sql
-- Durable Idempotency-Key store for non-idempotent POST creates (events, rounds,
-- members, guests, teams). The cellular "phantom create" failure mode is a create
-- that commits server-side while the last-mile ack is lost, so the client retries
-- and would otherwise create a SECOND row. The mobile client now sends a stable
-- Idempotency-Key per logical create (reused across its retries); this table lets the
-- backend replay the original response on a repeat instead of re-creating, so a retry
-- is safe.
--
-- Unlike middleware.IdempotencyStore (in-memory, detection-only, lost on restart and
-- not shared across replicas), this is durable — which is the prerequisite the
-- non-idempotent retry path required. response_status is NULL until the original
-- request finishes (an in-flight marker); a concurrent retry that finds NULL gets a
-- 409 and backs off. response_body is the captured response stored verbatim (TEXT, not
-- JSONB) so the replay is byte-identical to the original. Rows expire via expires_at
-- and are swept opportunistically by the store.

CREATE TABLE idempotency_keys (
    key             TEXT PRIMARY KEY,
    user_id         UUID NOT NULL,
    method          TEXT NOT NULL,
    path            TEXT NOT NULL,
    request_hash    TEXT NOT NULL,
    response_status INTEGER,
    response_body   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL
);

-- Supports the opportunistic cleanup sweep (DELETE WHERE expires_at < now()).
CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys (expires_at);
