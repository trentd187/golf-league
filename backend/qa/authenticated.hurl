# authenticated.hurl — Self-contained authenticated API regression suite.
# Step 1 signs in via Supabase and captures the JWT. All subsequent entries
# use the captured {{access_token}} — no manual token management required.
#
# Variables required in variables.env:
#   QA_BASE_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, QA_TEST_EMAIL, QA_TEST_PASSWORD
#
# Test user setup (one-time):
#   Supabase Dashboard → Authentication → Users → Add user → set email + password

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


# ── Step 2: Public events listing ──────────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/events/public
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$" isCollection


# ── Step 3: Authenticated user profile ─────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/me
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
jsonpath "$.id" isString


# ── Step 4: My rounds ──────────────────────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/rounds
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
jsonpath "$" isCollection


# ── Step 5: Course listing ─────────────────────────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/courses
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
jsonpath "$" isCollection
