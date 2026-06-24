# round_group_guest_crud.hurl — Self-cleaning round + group + guest flow (backlog item B8).
# Creates a standalone round, adds a group, adds a guest player to that group, confirms
# the guest shows up on the scorecard, then deletes the round. Leaves develop as found.
#
# Self-contained: Step 1 signs in via Supabase and captures the JWT (same pattern as
# authenticated.hurl). The QA test user (global role `user`) is auto-added as the
# round's organizer on create, so group/guest mutations and the final DELETE are authorized.
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
POST {{QA_BASE_URL}}/api/v1/rounds
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "name": "QA Guest Round {{newUuid}}",
  "scheduled_date": "2026-01-01",
  "course_id": "{{course_id}}",
  "default_tee_id": "{{tee_id}}"
}

HTTP 201
[Captures]
round_id: jsonpath "$.id"
[Asserts]
jsonpath "$.id" isString


# ── Step 5: Add a tee-time group to the round ───────────────────────────────────
POST {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/groups
Authorization: Bearer {{access_token}}
Content-Type: application/json

{}

HTTP 201
[Captures]
group_id: jsonpath "$.id"
[Asserts]
jsonpath "$.id" isString
jsonpath "$.group_number" exists


# ── Step 6: Add a guest player to the group ─────────────────────────────────────
POST {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/groups/{{group_id}}/guests
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "name": "QA Guest Player"
}

HTTP 201
[Asserts]
jsonpath "$.players" isCollection
# Exactly one guest in the group; the filter collapses to that guest's scalar name.
jsonpath "$.players[?(@.is_guest==true)].display_name" == "QA Guest Player"


# ── Step 7: Confirm the guest appears on the scorecard ──────────────────────────
# The scorecard nests players under groups[].players[]; the guest is the only
# is_guest player, so the filter collapses to that one scalar display_name.
GET {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}/scorecard
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
jsonpath "$.groups" isCollection
jsonpath "$.groups[*].players[?(@.is_guest==true)].display_name" == "QA Guest Player"


# ── Step 8: Delete the round (cleanup; group + guest cascade) ────────────────────
DELETE {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}
Authorization: Bearer {{access_token}}

HTTP 204


# ── Step 9: Confirm it is gone ──────────────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}
Authorization: Bearer {{access_token}}

HTTP 404
