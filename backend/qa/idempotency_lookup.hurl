# idempotency_lookup.hurl — GET /idempotency/:key create-side recovery regression (backlog B20).
# Proves handlers.LookupIdempotentResponse + DurableIdempotencyStore.Lookup end-to-end on live
# develop: after a create commits under an Idempotency-Key, GET /idempotency/:key REPLAYS the
# stored response (same id + `Idempotent-Replay: true`) so a client that lost every ack can
# recover the row; an unknown key returns 404. Self-cleaning: the single event is deleted.
#
# refresh_token doubles as the per-run key for the same reasons as idempotent_create_replay.hurl
# (pre-existing, byte-stable across requests, unique per run so a same-day re-run can't replay a
# prior run's now-deleted event while its key is still within the store TTL).
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


# ── Step 2: Create an event under the Idempotency-Key — the original commit ───────
POST {{QA_BASE_URL}}/api/v1/events
Authorization: Bearer {{access_token}}
Idempotency-Key: {{idem_key}}
Content-Type: application/json

{
  "name": "QA Idempotency Lookup {{idem_key}}",
  "event_type": "casual",
  "is_public": false
}

HTTP 201
[Captures]
event_id: jsonpath "$.id"
[Asserts]
jsonpath "$.id" isString


# ── Step 3: Recover by key — the committed create replays with the SAME id ────────
# This is the phantom-recovery path: had every POST ack been lost, the client would GET
# this to learn the id instead of surfacing "could not create". The replay preserves the
# ORIGINAL response status verbatim — a create is 201, so the lookup replays 201 (the
# client's recoverByKey accepts any 2xx). Not 200.
GET {{QA_BASE_URL}}/api/v1/idempotency/{{idem_key}}
Authorization: Bearer {{access_token}}

HTTP 201
[Asserts]
header "Idempotent-Replay" == "true"
jsonpath "$.id" == "{{event_id}}"


# ── Step 4: An unknown key is not recoverable — 404 ───────────────────────────────
GET {{QA_BASE_URL}}/api/v1/idempotency/{{newUuid}}
Authorization: Bearer {{access_token}}

HTTP 404


# ── Step 5: Delete the created event (cleanup) ────────────────────────────────────
DELETE {{QA_BASE_URL}}/api/v1/events/{{event_id}}
Authorization: Bearer {{access_token}}

HTTP 204


# ── Step 6: Confirm it is gone ────────────────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/events/{{event_id}}
Authorization: Bearer {{access_token}}

HTTP 404
