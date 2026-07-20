# event_round_crud.hurl — Self-cleaning event-linked round lifecycle (backlog item B23).
# Covers handlers.ScheduleEventRound (POST /events/:eventId/rounds): create an event,
# capture a real course_id/tee_id from develop (the QA user can't create courses),
# schedule a round UNDER the event, confirm it appears in the event's round list, then
# tear both down (round first, then event) and prove the event is gone with a trailing
# 404. Leaves develop exactly as found.
#
# Self-contained: Step 1 signs in via Supabase and captures the JWT (same pattern as
# authenticated.hurl). The QA test user (global role `user`) is auto-added as the event
# organizer on create and the round organizer on schedule — so DELETE is authorized.
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


# ── Step 2: Create a casual event to hang the round on ──────────────────────────
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
[Asserts]
jsonpath "$.id" isString
jsonpath "$.status" exists


# ── Step 3: Find a course with hole data (QA user can't create one) ─────────────
# has_holes==true guarantees at least one tee; the first course may be an empty test one.
GET {{QA_BASE_URL}}/api/v1/courses
Authorization: Bearer {{access_token}}

HTTP 200
[Captures]
course_id: jsonpath "$[?(@.has_holes==true)].id" nth 0
[Asserts]
jsonpath "$" isCollection
jsonpath "$[?(@.has_holes==true)].id" nth 0 isString


# ── Step 4: Load course detail to capture a tee_id ──────────────────────────────
GET {{QA_BASE_URL}}/api/v1/courses/{{course_id}}
Authorization: Bearer {{access_token}}

HTTP 200
[Captures]
tee_id: jsonpath "$.tees[0].id"
[Asserts]
jsonpath "$.id" == "{{course_id}}"
jsonpath "$.tees[0].id" isString


# ── Step 5: Schedule a round UNDER the event ────────────────────────────────────
POST {{QA_BASE_URL}}/api/v1/events/{{event_id}}/rounds
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "name": "QA Smoke Event Round {{newUuid}}",
  "scheduled_date": "2026-01-01",
  "course_id": "{{course_id}}",
  "default_tee_id": "{{tee_id}}"
}

HTTP 201
[Captures]
round_id: jsonpath "$.id"
[Asserts]
jsonpath "$.id" isString
jsonpath "$.name" startsWith "QA Smoke Event Round"
jsonpath "$.status" exists
jsonpath "$.scoring_format" exists


# ── Step 6: Confirm it appears in the event's round list ────────────────────────
GET {{QA_BASE_URL}}/api/v1/events/{{event_id}}/rounds
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
jsonpath "$" isCollection
# Exactly one round matches the unique id, so the filtered result is a scalar (Hurl
# unwraps a single-element filter match) — assert it directly, no `nth 0` (that expects a list).
jsonpath "$[?(@.id=='{{round_id}}')].id" == "{{round_id}}"


# ── Step 7: Delete the round (cleanup — round before event) ──────────────────────
DELETE {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}
Authorization: Bearer {{access_token}}

HTTP 204


# ── Step 8: Delete the event (cleanup) ──────────────────────────────────────────
DELETE {{QA_BASE_URL}}/api/v1/events/{{event_id}}
Authorization: Bearer {{access_token}}

HTTP 204


# ── Step 9: Confirm the event is gone ───────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/events/{{event_id}}
Authorization: Bearer {{access_token}}

HTTP 404
