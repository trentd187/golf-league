# users_search.hurl — B5: GET /api/v1/users?q=<query> → 200, JSON collection.
# Read-only: the user-search endpoint returns all users except the caller, filtered
# by the query string. The service always returns a non-nil slice (empty [] when
# nothing matches), so this is safe to run against develop without seeding.
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


# ── Step 2: User search returns a JSON collection ──────────────────────────────
GET {{QA_BASE_URL}}/api/v1/users?q=qa
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$" isCollection
