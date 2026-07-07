# me.hurl — B13: GET /api/v1/me → 200, returns the caller's user object.
# Read-only: asserts the authenticated user's own record comes back with a
# non-empty id and the QA user's email. Safe against develop (no seeding,
# no mutation) — it just reads the identity behind the bearer token.
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
jsonpath "$.access_token" isString


# ── Step 2: The caller's own user object ───────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/me
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$.id" isString
jsonpath "$.id" matches /.+/
jsonpath "$.email" == "{{QA_TEST_EMAIL}}"
