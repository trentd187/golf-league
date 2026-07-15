# import_external_forbidden.hurl — Non-admin external course import is rejected (backlog item B21).
#
# POST /api/v1/courses/import-external is admin-only (middleware.RequireRole("admin")). The QA
# test user has global role `user`, so this is a NEGATIVE test: the route must answer 403.
#
# Why it's worth a regression test: RequireRole runs as middleware BEFORE the handler, so a
# non-admin is rejected regardless of whether GOLF_COURSE_API_KEY is configured on develop —
# the 403 is a pure authorization signal. If this route silently lost its guard, any league
# member could pull arbitrary external courses into the shared catalog. Mirrors B2 / B20.
#
# No mutation is attempted beyond the rejected POST, so nothing to clean up.
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


# ── Step 2: Attempt an external import as a non-admin → 403 ─────────────────────
# The admin guard must reject this before the handler ever touches GolfCourseAPI, so the
# external_id below is never imported. A 201/200 here means the RequireRole guard is gone.
POST {{QA_BASE_URL}}/api/v1/courses/import-external
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "external_id": 999999999
}

HTTP 403
