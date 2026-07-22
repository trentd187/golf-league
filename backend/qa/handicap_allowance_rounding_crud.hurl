# handicap_allowance_rounding_crud.hurl — Self-cleaning WHS allowance-rounding flow (backlog item B26).
# Verifies EffectiveCourseHandicap rounds an allowance-adjusted course handicap to the
# NEAREST whole number (0.5 up), not floor: an event with a 90% handicap allowance and a
# guest whose course handicap is 15 → effective 14 (15 × 0.90 = 13.5 → 14). Plain floor,
# the old behaviour, would have produced 13. Uses the guest flow because it lets us set a
# course handicap directly on an event-linked round (guests join with event_player_id NULL
# even on event rounds), and event rounds don't auto-add the creator as a player.
#
# Self-contained: Step 1 signs in via Supabase and captures the JWT (same pattern as
# authenticated.hurl). The QA test user (global role `user`) is the event + round organizer,
# so the group/guest mutations and the DELETEs are authorized. Round is torn down before the
# event; leaves develop as found.
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


# ── Step 2: Create a league event WITH a 90% handicap allowance ─────────────────
POST {{QA_BASE_URL}}/api/v1/events
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "name": "QA Allowance Event {{newUuid}}",
  "event_type": "league",
  "is_public": false,
  "handicap_allowance": 90
}

HTTP 201
[Captures]
event_id: jsonpath "$.id"
[Asserts]
jsonpath "$.id" isString
jsonpath "$.handicap_allowance" == 90


# ── Step 3: Find a course with hole data (QA user can't create one) ──────────────
GET {{QA_BASE_URL}}/api/v1/courses
Authorization: Bearer {{access_token}}

HTTP 200
[Captures]
course_id: jsonpath "$[?(@.has_holes==true)].id" nth 0
[Asserts]
jsonpath "$[?(@.has_holes==true)].id" nth 0 isString


# ── Step 4: Load course detail to capture a tee_id ──────────────────────────────
GET {{QA_BASE_URL}}/api/v1/courses/{{course_id}}
Authorization: Bearer {{access_token}}

HTTP 200
[Captures]
tee_id: jsonpath "$.tees[0].id"
[Asserts]
jsonpath "$.tees[0].id" isString


# ── Step 5: Schedule a round UNDER the event (inherits the allowance) ────────────
POST {{QA_BASE_URL}}/api/v1/events/{{event_id}}/rounds
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "name": "QA Allowance Round {{newUuid}}",
  "scheduled_date": "2026-01-01",
  "course_id": "{{course_id}}",
  "default_tee_id": "{{tee_id}}"
}

HTTP 201
[Captures]
round_id: jsonpath "$.id"
[Asserts]
jsonpath "$.id" isString


# ── Step 6: Add a tee-time group ────────────────────────────────────────────────
POST {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/groups
Authorization: Bearer {{access_token}}
Content-Type: application/json

{}

HTTP 201
[Captures]
group_id: jsonpath "$.id"
[Asserts]
jsonpath "$.id" isString


# ── Step 7: Add a guest with a course handicap of 15 ────────────────────────────
POST {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/groups/{{group_id}}/guests
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "name": "QA Allowance Guest",
  "course_handicap": 15
}

HTTP 201
[Asserts]
jsonpath "$.players[?(@.is_guest==true)].display_name" == "QA Allowance Guest"


# ── Step 8: Scorecard shows 15 rounded to 14 under the 90% allowance ─────────────
# 15 × 0.90 = 13.5 → round-half-up = 14 (plain floor would have given 13). The guest is
# the only is_guest player, so each filter collapses to that one scalar.
GET {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/scorecard
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
jsonpath "$.groups[*].players[?(@.is_guest==true)].course_handicap" == 15
jsonpath "$.groups[*].players[?(@.is_guest==true)].effective_course_handicap" == 14


# ── Step 9: Delete the round (cleanup — round before event) ──────────────────────
DELETE {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}
Authorization: Bearer {{access_token}}

HTTP 204


# ── Step 10: Delete the event (cleanup) ─────────────────────────────────────────
DELETE {{QA_BASE_URL}}/api/v1/events/{{event_id}}
Authorization: Bearer {{access_token}}

HTTP 204


# ── Step 11: Confirm the event is gone ──────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/events/{{event_id}}
Authorization: Bearer {{access_token}}

HTTP 404
