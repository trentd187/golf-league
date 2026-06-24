# event_member_role_crud.hurl — Self-cleaning event membership flow (backlog item B11).
# Creates an event (the QA user is auto-added as its sole organizer), reads the member
# list, exercises the PATCH .../members/:userId/role path, then deletes the event. Leaves
# develop as found.
#
# Self-contained: Step 1 signs in via Supabase and captures the JWT (same pattern as
# authenticated.hurl). The QA test user (global role `user`) is the event organizer, so
# GET members, PATCH role and the final DELETE are authorized.
#
# Why PATCH to "organizer" (a no-op) rather than demote to "player": the QA user is the
# only member, and EventService.UpdateMemberRole refuses to demote the last organizer
# (ErrLastOrganizer → 409). Re-setting the existing "organizer" role is a valid update that
# still drives the full handler + service path and returns 204.
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


# ── Step 2: Create a casual event (creator auto-joins as organizer) ─────────────
POST {{QA_BASE_URL}}/api/v1/events
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "name": "QA Member Event {{newUuid}}",
  "event_type": "casual",
  "is_public": false
}

HTTP 201
[Captures]
event_id: jsonpath "$.id"
[Asserts]
jsonpath "$.id" isString


# ── Step 3: List members — the creator is the sole organizer ────────────────────
GET {{QA_BASE_URL}}/api/v1/events/{{event_id}}/members
Authorization: Bearer {{access_token}}

HTTP 200
[Captures]
member_user_id: jsonpath "$[0].user_id"
[Asserts]
jsonpath "$" isCollection
jsonpath "$[0].user_id" isString
jsonpath "$[0].role" == "organizer"


# ── Step 4: Exercise the role-update path (no-op re-set to organizer → 204) ──────
PATCH {{QA_BASE_URL}}/api/v1/events/{{event_id}}/members/{{member_user_id}}/role
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "role": "organizer"
}

HTTP 204


# ── Step 5: Confirm the role is still organizer after the update ─────────────────
GET {{QA_BASE_URL}}/api/v1/events/{{event_id}}/members
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
jsonpath "$[0].user_id" == "{{member_user_id}}"
jsonpath "$[0].role" == "organizer"


# ── Step 6: Delete the event (cleanup; members cascade) ─────────────────────────
DELETE {{QA_BASE_URL}}/api/v1/events/{{event_id}}
Authorization: Bearer {{access_token}}

HTTP 204


# ── Step 7: Confirm it is gone ──────────────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/events/{{event_id}}
Authorization: Bearer {{access_token}}

HTTP 404
