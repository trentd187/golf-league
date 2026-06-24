# score_entry_crud.hurl — Self-cleaning score-entry flow (backlog item B9).
# Creates a standalone round (the creator is auto-added to Group 1 as a player), starts
# the round, sets that player's handicap, enters a hole score, confirms it lands on the
# scorecard, then deletes the round. Leaves develop as found.
#
# Self-contained: Step 1 signs in via Supabase and captures the JWT (same pattern as
# authenticated.hurl). The QA test user (global role `user`) is the round's organizer and
# its sole player, so the handicap/score mutations and the final DELETE are authorized.
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
  "name": "QA Score Round {{newUuid}}",
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
# The auto-created Group 1 holds exactly one player (the QA user); the scorecard nests
# players under groups[].players[].
GET {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/scorecard
Authorization: Bearer {{access_token}}

HTTP 200
[Captures]
round_player_id: jsonpath "$.groups[0].players[0].round_player_id"
[Asserts]
jsonpath "$.groups[0].players[0].round_player_id" isString
jsonpath "$.groups[0].players[0].is_guest" == false


# ── Step 6: Start the round (scores can only be entered while active) ────────────
PATCH {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "status": "active"
}

HTTP 200
[Asserts]
jsonpath "$.status" == "active"


# ── Step 7: Set the player's course handicap ────────────────────────────────────
PUT {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/players/{{round_player_id}}/handicap
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "course_handicap": 10
}

HTTP 200
[Asserts]
jsonpath "$.course_handicap" == 10


# ── Step 8: Enter a score for hole 1 ────────────────────────────────────────────
PUT {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/players/{{round_player_id}}/scores
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "scores": [
    { "hole_number": 1, "gross_score": 4 }
  ]
}

HTTP 200
[Asserts]
jsonpath "$.saved" exists


# ── Step 9: Confirm the score appears on the scorecard ──────────────────────────
# The only player is the QA user with a single hole-1 score, so the recursive filter
# collapses to that one scalar gross_score (4) rather than a collection.
GET {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/scorecard
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
jsonpath "$..scores[?(@.hole_number==1)].gross_score" == 4


# ── Step 10: Delete the round (cleanup; group + player + scores cascade) ─────────
DELETE {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}
Authorization: Bearer {{access_token}}

HTTP 204


# ── Step 11: Confirm it is gone ─────────────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}
Authorization: Bearer {{access_token}}

HTTP 404
