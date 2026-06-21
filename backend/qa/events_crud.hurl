# events_crud.hurl — Self-cleaning event lifecycle regression (backlog item B6).
# Exercises the full create → read → update → delete path for an event as the QA
# user, then proves cleanup with a trailing 404. Leaves develop exactly as found.
#
# Self-contained: Step 1 signs in via Supabase and captures the JWT (same pattern as
# authenticated.hurl). All mutations run as the QA test user (global role `user`),
# who is auto-added as the event organizer on create — so PATCH/DELETE are authorized.
#
# Variables required in variables.env:
#   QA_BASE_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, QA_TEST_EMAIL, QA_TEST_PASSWORD

# ── Step 1: Sign in and capture token ──────────────────────────────────────────
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
[Asserts]
jsonpath "$.token_type" == "bearer"
jsonpath "$.access_token" isString


# ── Step 2: Create a casual event ──────────────────────────────────────────────
# newUuid keeps the name unique per run so concurrent/leftover data never collides.
POST {{QA_BASE_URL}}/api/v1/events
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "name": "QA Smoke Event {{newUuid}}",
  "event_type": "casual",
  "is_public": false
}

HTTP 201
[Captures]
event_id: jsonpath "$.id"
event_name: jsonpath "$.name"
[Asserts]
jsonpath "$.id" isString
jsonpath "$.name" startsWith "QA Smoke Event"
jsonpath "$.event_type" == "casual"
jsonpath "$.status" exists


# ── Step 3: Read it back ───────────────────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/events/{{event_id}}
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
jsonpath "$.id" == "{{event_id}}"
jsonpath "$.name" == "{{event_name}}"
jsonpath "$.members" isCollection


# ── Step 4: Cancel it (status update returns the updated event) ─────────────────
PATCH {{QA_BASE_URL}}/api/v1/events/{{event_id}}
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "status": "cancelled"
}

HTTP 200
[Asserts]
jsonpath "$.id" == "{{event_id}}"
jsonpath "$.status" == "cancelled"


# ── Step 5: Delete it (cleanup) ────────────────────────────────────────────────
DELETE {{QA_BASE_URL}}/api/v1/events/{{event_id}}
Authorization: Bearer {{access_token}}

HTTP 204


# ── Step 6: Confirm it is gone ─────────────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/events/{{event_id}}
Authorization: Bearer {{access_token}}

HTTP 404
