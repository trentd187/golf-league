# my_rounds.hurl — B15: GET /api/v1/rounds (GetMyRounds) → 200, JSON collection.
# Read-only: asserts the caller's rounds listing comes back as a JSON array. Safe
# against develop (no seeding, no mutation) — it just reads the signed-in user's rounds.
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


# ── Step 2: The caller's rounds ────────────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/rounds
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$" isCollection
