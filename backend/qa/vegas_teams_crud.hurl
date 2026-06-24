# vegas_teams_crud.hurl — Self-cleaning Vegas team flow (backlog item B10).
# Creates a Las Vegas round (the creator is auto-added to Group 1 as a player), creates a
# team, assigns the creator's round_player to it, confirms the team lists that member, then
# deletes the round. Leaves develop as found.
#
# Self-contained: Step 1 signs in via Supabase and captures the JWT (same pattern as
# authenticated.hurl). The QA test user (global role `user`) is the round's organizer, so
# the team CRUD mutations and the final DELETE are authorized. Vegas teams cap at 2 members;
# assigning the lone QA player (1 member) is a valid smoke of POST/PUT/GET/DELETE team routes.
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


# ── Step 4: Create a Las Vegas round ────────────────────────────────────────────
# scoring_format=las_vegas enables the teams machinery; the creator auto-joins Group 1.
POST {{QA_BASE_URL}}/api/v1/rounds
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "name": "QA Vegas Round {{newUuid}}",
  "scheduled_date": "2026-01-01",
  "course_id": "{{course_id}}",
  "default_tee_id": "{{tee_id}}",
  "scoring_format": "las_vegas"
}

HTTP 201
[Captures]
round_id: jsonpath "$.id"
[Asserts]
jsonpath "$.id" isString
jsonpath "$.scoring_format" == "las_vegas"


# ── Step 5: Capture the creator's round_player_id from the scorecard ─────────────
GET {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/scorecard
Authorization: Bearer {{access_token}}

HTTP 200
[Captures]
round_player_id: jsonpath "$.groups[0].players[0].round_player_id"
[Asserts]
jsonpath "$.groups[0].players[0].round_player_id" isString


# ── Step 6: Create a team ───────────────────────────────────────────────────────
POST {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/teams
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "name": "Team A"
}

HTTP 201
[Captures]
team_id: jsonpath "$.id"
[Asserts]
jsonpath "$.id" isString
jsonpath "$.name" == "Team A"


# ── Step 7: Assign the creator's round_player to the team ───────────────────────
PUT {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/teams/{{team_id}}/members
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "round_player_ids": ["{{round_player_id}}"]
}

HTTP 200
[Asserts]
jsonpath "$.members[0].round_player_id" == "{{round_player_id}}"


# ── Step 8: Confirm the team + member appear in the list ────────────────────────
GET {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/teams
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
jsonpath "$[0].id" == "{{team_id}}"
jsonpath "$[0].members[0].round_player_id" == "{{round_player_id}}"


# ── Step 9: Delete the round (cleanup; teams + members + player cascade) ─────────
DELETE {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}
Authorization: Bearer {{access_token}}

HTTP 204


# ── Step 10: Confirm it is gone ─────────────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}
Authorization: Bearer {{access_token}}

HTTP 404
