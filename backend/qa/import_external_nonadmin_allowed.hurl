# import_external_nonadmin_allowed.hurl — Any authenticated user can import an external course (B21).
#
# POST /api/v1/courses/import-external is no longer admin-gated: downloading a NEW course from
# GolfCourseAPI is open to every authenticated user (only editing an already-downloaded course
# stays admin-only). The QA test user has global role `user`, so this is a POSITIVE authorization
# test — the request must get PAST the role middleware instead of being rejected with 403.
#
# Why assert "not 403" rather than a successful 201: a real import would depend on
# GOLF_COURSE_API_KEY being configured on develop AND a valid external_id, and would pollute the
# shared course catalog on every QA run. Using a bogus external_id proves the RequireRole guard is
# gone (the handler is reached) without writing anything. If the guard ever came back, this returns
# 403 and the test fails. Inverse of the old B21 negative test; B2/B20 (course/tee create) stay 403.
#
# No course is created, so nothing to clean up.
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


# ── Step 2: Import as a non-admin → must NOT be 403 ─────────────────────────────
# A non-admin reaching the handler (any status but 403) proves the role guard is gone. The bogus
# external_id means the handler fails downstream (503 if the API key is unset, or a 4xx/5xx from
# GolfCourseAPI) rather than creating a course — so this never pollutes the catalog.
POST {{QA_BASE_URL}}/api/v1/courses/import-external
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "external_id": 999999999
}

HTTP *
[Asserts]
status != 403
