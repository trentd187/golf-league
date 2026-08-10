# handicap_bounds_crud.hurl — Self-cleaning course-handicap bounds + plus-handicap flow (backlog item B25).
# Creates a standalone round (the creator is auto-added to Group 1 as a player), then
# exercises the new course_handicap validation on the live PUT .../handicap route:
#   - an out-of-range value (99) is rejected 400 (validateCourseHandicap, -10..54),
#   - a plus handicap (-2, golf "+2") is accepted 200 and stored as-is,
#   - the scorecard reflects the negative (plus) handicap,
# then deletes the round. Leaves develop as found.
#
# Covers services.validateCourseHandicap + signed plus-handicap storage shipped with the
# plus-handicap feature. Self-contained: Step 1 signs in via Supabase and captures the JWT
# (same pattern as authenticated.hurl). The QA test user (global role `user`) is the round's
# organizer and sole player, so the handicap mutations and the final DELETE are authorized.
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


# ── Step 2: Find a course with hole data (QA user can't create one) ──────────────
GET {{QA_BASE_URL}}/api/v1/courses
Authorization: Bearer {{access_token}}

HTTP 200
[Captures]
course_id: jsonpath "$[?(@.has_holes==true)].id" nth 0
[Asserts]
jsonpath "$[?(@.has_holes==true)].id" nth 0 isString


# ── Step 3: Load course detail to capture a tee_id ──────────────────────────────
GET {{QA_BASE_URL}}/api/v1/courses/{{course_id}}
Authorization: Bearer {{access_token}}

HTTP 200
[Captures]
tee_id: jsonpath "$.tees[0].id"
[Asserts]
jsonpath "$.tees[0].id" isString


# ── Step 4: Create a standalone (eventless) round ───────────────────────────────
# The creator is auto-added to Group 1 as a round_player, so no separate add-player call.
POST {{QA_BASE_URL}}/api/v1/rounds
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "name": "QA Handicap Round {{newUuid}}",
  "scheduled_date": "2026-01-01",
  "course_id": "{{course_id}}",
  "default_tee_id": "{{tee_id}}"
}

HTTP 201
[Captures]
round_id: jsonpath "$.id"
[Asserts]
jsonpath "$.id" isString


# ── Step 5: Capture the creator's round_player_id from the scorecard ─────────────
GET {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/scorecard
Authorization: Bearer {{access_token}}

HTTP 200
[Captures]
round_player_id: jsonpath "$.groups[0].players[0].round_player_id"
[Asserts]
jsonpath "$.groups[0].players[0].round_player_id" isString


# ── Step 6: Reject an out-of-range course handicap (99 > max 54) ─────────────────
# validateCourseHandicap runs before the permission/active checks, so a scheduled
# round still returns a 400 ValidationError here.
PUT {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/players/{{round_player_id}}/handicap
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "course_handicap": 99
}

HTTP 400
[Asserts]
jsonpath "$.error" matches /course_handicap/


# ── Step 7: Accept a plus handicap (+2, stored as -2) ────────────────────────────
PUT {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/players/{{round_player_id}}/handicap
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "course_handicap": -2
}

HTTP 200
[Asserts]
jsonpath "$.course_handicap" == -2


# ── Step 8: Confirm the scorecard reflects the plus handicap ─────────────────────
GET {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/scorecard
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
jsonpath "$.groups[0].players[0].course_handicap" == -2


# ── Step 9: Delete the round (cleanup; group + player cascade) ───────────────────
DELETE {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}
Authorization: Bearer {{access_token}}

HTTP 204


# ── Step 10: Confirm it is gone ─────────────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}
Authorization: Bearer {{access_token}}

HTTP 404
