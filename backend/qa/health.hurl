# health.hurl — Smoke test for the API server liveness endpoint.
# No auth required. Should pass even before the database is seeded.
GET {{QA_BASE_URL}}/health

HTTP 200
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$.status" == "ok"
