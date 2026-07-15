# ws_sunset.hurl
# The retired live-score WebSocket must answer 410 Gone — WITHOUT auth.
#
# Why this test exists. The socket was removed (it echoed every save back to the device that
# made it, reflowing the scorecard mid-tap and swallowing FIR/GIR presses, and it never once
# completed a wss handshake on the league's cellular network). Builds already on players'
# phones still dial the route, so it survives as a tombstone: a definitive 410 lets their
# reconnect loop reach its give-up cap once and settle on the 60s poll instead of storming.
#
# The subtlety this test pins: the route lives under /api/v1 but must NOT be behind that
# group's auth middleware. Fiber's app.Group mounts middleware on the PATH PREFIX, so it runs
# for every request under /api/v1 — including routes registered on `app` afterwards. Get the
# order wrong and an old client (which sends its JWT as ?token=, never as an Authorization
# header) gets a 401 it cannot act on, and the sampled ws.sunset_hit log — our only signal for
# when it is safe to delete the route — never fires. The first deploy of this change had
# exactly that bug; it was caught here, against live.
#
# No sign-in step: being reachable unauthenticated IS the assertion.

# ── 1. No auth header at all → 410, not 401 ───────────────────────────────────
GET {{QA_BASE_URL}}/api/v1/ws/rounds/00000000-0000-0000-0000-000000000001

HTTP 410
[Asserts]
jsonpath "$.error" contains "no longer available"

# ── 2. The real shape an old build sends: ?token= plus upgrade headers ────────
# It must still get a clean 410 rather than an upgrade, a hang, or a 401.
GET {{QA_BASE_URL}}/api/v1/ws/rounds/00000000-0000-0000-0000-000000000001?token=stale-jwt-from-an-old-build
Connection: Upgrade
Upgrade: websocket

HTTP 410
[Asserts]
jsonpath "$.error" exists
