# follow_self_400.hurl — B19: POST /api/v1/users/:self/follow → 400 "cannot follow yourself".
# Negative path, no mutation: signs in, resolves the caller's own id via GET /me, then tries
# to follow itself. The service rejects caller == target with ErrFollowSelf, which the handler
# maps to 400 {"error":"cannot follow yourself"} — so no follow row is ever created and develop
# is left untouched. Mirrors the B16/B17 self-id capture pattern.
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


# ── Step 3: Following yourself is rejected with 400 (no follow row created) ─────
POST {{QA_BASE_URL}}/api/v1/users/{{self_id}}/follow
Authorization: Bearer {{access_token}}

HTTP 400
[Asserts]
jsonpath "$.error" == "cannot follow yourself"
