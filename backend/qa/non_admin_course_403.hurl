# non_admin_course_403.hurl — Negative RBAC regression (backlog item B2).
# Course creation is admin-only (middleware.RequireRole("admin")). The QA test user
# has the global role `user`, so POST /api/v1/courses must be rejected with 403 BEFORE
# the handler runs — no course is created, so this test writes nothing to clean up.
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


# ── Step 2: Non-admin course create is forbidden ───────────────────────────────
# RequireRole("admin") rejects before the body is parsed, so the 403 holds regardless
# of payload — and nothing is persisted.
POST {{QA_BASE_URL}}/api/v1/courses
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "name": "QA Should Not Create {{newUuid}}"
}

HTTP 403
