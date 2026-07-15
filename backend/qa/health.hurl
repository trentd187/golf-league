# health.hurl — Smoke test for the API server readiness endpoint.
# No auth required. Should pass even before the database is seeded.
#
# /health checks BOTH dependencies, because a failure in either makes the service useless while
# leaving the process perfectly alive:
#
#   - db:   a wedged connection pool (process up, every request 502s).
#   - jwks: ZERO Supabase verifying keys. If the JWKS was unreachable at boot, the server came
#           up with an empty key set and 401'd EVERY authenticated request — a total auth
#           outage — while this endpoint still returned 200, so Railway never restarted it.
#           Asserting jwks here means a deploy in that state fails QA loudly, instead of
#           quietly serving nothing but 401s.
GET {{QA_BASE_URL}}/health

HTTP 200
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$.status" == "ok"
jsonpath "$.db" == "up"
jsonpath "$.jwks" == "ok"
