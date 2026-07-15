# tee_create_forbidden.hurl — Non-admin tee create is rejected (backlog item B20).
#
# Course / tee / hole CRUD is admin-only (middleware.RequireRole("admin")). The QA test user
# has global role `user`, so this is a NEGATIVE test: the route must answer 403, not 201.
#
# Why it's worth a regression test: the failure mode is silent and expensive. A route that
# quietly loses its RequireRole guard doesn't error — it succeeds, and any league member can
# rewrite the tees (course rating, slope, stroke indexes) under every round ever played on
# them. Mirrors B2 (non-admin course create).
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


# ── Step 2: Capture a real course id ───────────────────────────────────────────
# The QA user cannot create courses, so we target one develop already has.
GET {{QA_BASE_URL}}/api/v1/courses
Authorization: Bearer {{access_token}}

HTTP 200
[Captures]
course_id: jsonpath "$[0].id"
[Asserts]
jsonpath "$" isCollection


# ── Step 3: Attempt a tee create as a non-admin → 403 ──────────────────────────
# The tee is never created; a 201 here means the admin guard is gone.
POST {{QA_BASE_URL}}/api/v1/courses/{{course_id}}/tees
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "name": "QA Should Never Exist",
  "course_rating": 72.0,
  "slope_rating": 113,
  "par": 72
}

HTTP 403


# ── Step 4: Prove the tee really wasn't created ────────────────────────────────
# A 403 that still wrote the row would be worse than no guard at all.
GET {{QA_BASE_URL}}/api/v1/courses/{{course_id}}
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
jsonpath "$.tees[*].name" not contains "QA Should Never Exist"
