# events_public.hurl — B14: GET /api/v1/events/public → 200, JSON collection.
# Read-only: asserts the public-events listing comes back as a JSON array. Safe
# against develop (no seeding, no mutation) — it just reads the public feed.
#
# Variables required in variables.env:
#   QA_BASE_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, QA_TEST_EMAIL, QA_TEST_PASSWORD

# ── Step 1: Sign in and capture token ──────────────────────────────────────────
# The route is under the authenticated /api/v1 group, so we send a bearer like every
# other QA file (harmless even though the feed itself is "public").
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


# ── Step 2: The public events feed ─────────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/events/public
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$" isCollection
