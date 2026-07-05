# user_stats.hurl — B16: GET /api/v1/users/:self/stats?filter=all_time → 200, stats object.
# Read-only: signs in, resolves the caller's own id via GET /me, then reads their career
# stats. Asserts the always-present integer counters (a user with no completed rounds still
# returns zeros — the nullable averages are pointers, the counts are not). Safe against
# develop (no seeding, no mutation).
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


# ── Step 3: Career stats for the all_time filter ───────────────────────────────
GET {{QA_BASE_URL}}/api/v1/users/{{self_id}}/stats?filter=all_time
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$.rounds_counted" isInteger
jsonpath "$.birdies" isInteger
jsonpath "$.pars" isInteger
