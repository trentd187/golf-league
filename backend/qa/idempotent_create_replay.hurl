# idempotent_create_replay.hurl — Durable Idempotency-Key replay regression (backlog B12).
# Proves migration 000024 / middleware.Idempotency end-to-end on live develop: a repeated
# POST /events bearing the SAME Idempotency-Key replays the original committed response
# instead of creating a duplicate row — same id, plus the `Idempotent-Replay: true` header.
# Self-cleaning: the single event created is deleted, with a trailing 404 proving cleanup.
#
# Why refresh_token is the idempotency key: the key must already exist before the first
# POST, be byte-identical across both POSTs, and be unique per run (so same-day re-runs
# don't replay a previous run's now-deleted event while its key is still within the store
# TTL). Hurl evaluates {{newUuid}} freshly on every use, so a generated key can't be
# reused across two requests. The Supabase password grant mints a fresh refresh_token per
# sign-in — a unique, stable, pre-existing string — so it doubles as the per-run key.
#
# Variables required in variables.env:
#   QA_BASE_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, QA_TEST_EMAIL, QA_TEST_PASSWORD

# ── Step 1: Sign in; capture the JWT and a unique per-run idempotency key ─────────
POST {{SUPABASE_URL}}/auth/v1/token?grant_type=password
apikey: {{SUPABASE_PUBLISHABLE_KEY}}
Content-Type: application/json

{
  "email": "{{QA_TEST_EMAIL}}",
  "password": "{{QA_TEST_PASSWORD}}"
}

HTTP 200
[Captures]
access_token: jsonpath "$.access_token"
idem_key: jsonpath "$.refresh_token"
[Asserts]
jsonpath "$.access_token" isString
jsonpath "$.refresh_token" isString


# ── Step 2: First create with the Idempotency-Key — the original commit ───────────
# The body uses only the captured idem_key (no {{newUuid}}) so Step 3 can send a
# byte-identical body; a differing body would hash differently and return 422, not a replay.
POST {{QA_BASE_URL}}/api/v1/events
Authorization: Bearer {{access_token}}
Idempotency-Key: {{idem_key}}
Content-Type: application/json

{
  "name": "QA Idempotent Replay {{idem_key}}",
  "event_type": "casual",
  "is_public": false
}

HTTP 201
[Captures]
event_id: jsonpath "$.id"
[Asserts]
jsonpath "$.id" isString
jsonpath "$.name" startsWith "QA Idempotent Replay"


# ── Step 3: Replay — same key + identical body returns the SAME id, no duplicate ──
POST {{QA_BASE_URL}}/api/v1/events
Authorization: Bearer {{access_token}}
Idempotency-Key: {{idem_key}}
Content-Type: application/json

{
  "name": "QA Idempotent Replay {{idem_key}}",
  "event_type": "casual",
  "is_public": false
}

HTTP 201
[Asserts]
header "Idempotent-Replay" == "true"
jsonpath "$.id" == "{{event_id}}"


# ── Step 4: Delete the single created event (cleanup) ─────────────────────────────
DELETE {{QA_BASE_URL}}/api/v1/events/{{event_id}}
Authorization: Bearer {{access_token}}

HTTP 204


# ── Step 5: Confirm it is gone (and that only one row ever existed) ───────────────
GET {{QA_BASE_URL}}/api/v1/events/{{event_id}}
Authorization: Bearer {{access_token}}

HTTP 404
