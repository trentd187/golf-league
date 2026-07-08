# user_rounds.hurl — B17: GET /api/v1/users/:self/rounds → 200, JSON collection.
# Read-only: signs in, resolves the caller's own id via GET /me, then reads that user's
# rounds list. A user with no rounds still returns an (empty) collection, so this is safe
# against develop with no seeding or mutation. Mirrors the B16 self-id pattern.
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


# ── Step 2: Resolve the caller's own user id ───────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/me
Authorization: Bearer {{access_token}}

HTTP 200
[Captures]
self_id: jsonpath "$.id"


# ── Step 3: That user's rounds — a JSON collection ─────────────────────────────
GET {{QA_BASE_URL}}/api/v1/users/{{self_id}}/rounds
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$" isCollection
