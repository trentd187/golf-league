# unauth_me.hurl — Negative auth regression: the profile endpoint must reject
# a request with no bearer token. No data is created or read; this only proves the
# Auth middleware rejects anonymous callers on a protected route. (Backlog B1)
GET {{QA_BASE_URL}}/api/v1/me

HTTP 401
