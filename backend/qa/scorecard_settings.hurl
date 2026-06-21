# scorecard_settings.hurl — B3: GET /api/v1/users/me/scorecard-settings → 200.
# Read-only: the QA user's stat-visibility preferences. The endpoint returns sensible
# defaults when no row exists, so this is safe to run against develop without seeding.
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


# ── Step 2: Scorecard settings returns a populated settings object ─────────────
GET {{QA_BASE_URL}}/api/v1/users/me/scorecard-settings
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$.score_position" isString
jsonpath "$.stat_order" isCollection
jsonpath "$.fir_enabled" isBoolean
jsonpath "$.show_group_on_scorecard" isBoolean
