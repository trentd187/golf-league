# eventless_round_crud.hurl — Self-cleaning eventless-round lifecycle (backlog item B7).
# Captures a real course_id/tee_id from develop (the QA user can't create courses),
# creates a standalone round, reads it back, deletes it, then proves cleanup with a
# trailing 404. Leaves develop exactly as found.
#
# Self-contained: Step 1 signs in via Supabase and captures the JWT (same pattern as
# authenticated.hurl). The QA test user (global role `user`) is auto-added as the
# round's organizer on create, so DELETE is authorized.
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


# ── Step 2: Find a course with hole data (QA user can't create one) ──────────────
# Filter to a course where has_holes==true (so it definitely has at least one tee);
# the alphabetically-first course may be an empty test course with zero tees.
GET {{QA_BASE_URL}}/api/v1/courses
Authorization: Bearer {{access_token}}

HTTP 200
[Captures]
course_id: jsonpath "$[?(@.has_holes==true)].id" nth 0
[Asserts]
jsonpath "$" isCollection
jsonpath "$[?(@.has_holes==true)].id" nth 0 isString


# ── Step 3: Load course detail to capture a tee_id ──────────────────────────────
GET {{QA_BASE_URL}}/api/v1/courses/{{course_id}}
Authorization: Bearer {{access_token}}

HTTP 200
[Captures]
tee_id: jsonpath "$.tees[0].id"
[Asserts]
jsonpath "$.id" == "{{course_id}}"
jsonpath "$.tees" isCollection
jsonpath "$.tees[0].id" isString


# ── Step 4: Create a standalone (eventless) round ───────────────────────────────
POST {{QA_BASE_URL}}/api/v1/rounds
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "name": "QA Smoke Round {{newUuid}}",
  "scheduled_date": "2026-01-01",
  "course_id": "{{course_id}}",
  "default_tee_id": "{{tee_id}}"
}

HTTP 201
[Captures]
round_id: jsonpath "$.id"
[Asserts]
jsonpath "$.id" isString
jsonpath "$.name" startsWith "QA Smoke Round"
jsonpath "$.status" exists
jsonpath "$.scoring_format" exists


# ── Step 5: Read it back ────────────────────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
jsonpath "$.id" == "{{round_id}}"
jsonpath "$.is_organizer" == true
jsonpath "$.groups" isCollection


# ── Step 6: Delete it (cleanup) ─────────────────────────────────────────────────
DELETE {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}
Authorization: Bearer {{access_token}}

HTTP 204


# ── Step 7: Confirm it is gone ──────────────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/rounds/{{round_id}}
Authorization: Bearer {{access_token}}

HTTP 404
