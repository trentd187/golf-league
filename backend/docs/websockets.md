# Live-Score WebSockets

Real-time scorecard updates. When a player saves a score, every client watching that
round gets a tiny push and refetches immediately, instead of waiting on the scorecard's
60s poll.

> **Resilience guarantee.** The WebSocket is a *latency enhancement only*. The scorecard's
> 60s `refetchInterval` ([mobile/app/scorecard/[roundId].tsx](../../mobile/app/scorecard/[roundId].tsx))
> stays as the floor: if the socket can't connect (server down, token expired, reconnects
> exhausted) the screen still updates on the poll — never a stuck or blank scorecard. Both
> sides assume the link is flaky (the same cellular last-mile that caused the phantom-save bug).

## Shape

```
score PUT ──▶ ScoreService save ──▶ hub.BroadcastToRound(roundId, {"type":"scores_updated"})
                                        │
            client WS  ◀───────────────┘   (one message per round, no score data)
                │
                ├─▶ queryClient.invalidateQueries(["scorecard", roundId])  ──▶ refetch
                │
                └─▶ scorecard screen 3-way-merges the fresh snapshot into local edit
                    state  (utils/scorecard.ts threeWayMerge*)  ──▶ peers' scores appear
```

The message carries **no** score data — just "something changed" — so the client reuses its
existing scorecard query. That keeps the server payload trivial and the client a one-line
invalidate rather than a second data path.

The scorecard holds scores/stats in **local** React state (the editable TextInputs), so the
refetch alone isn't enough — the screen must fold the fresh server snapshot back into that
local state. It does a **3-way merge** (`threeWayMergeScores`/`Stats`/`Handicaps` in
[mobile/utils/scorecard.ts](../../mobile/utils/scorecard.ts)) against the last synced server
snapshot: peers' cells flow in, while this device's unsaved in-flight edits are preserved until
the server echoes them back. Without this, other players' scores only appeared on exit/re-entry.

## Backend

| Concern | Location |
|---|---|
| Hub (broadcast loop, register/unregister, slow-consumer eviction) | [internal/websocket/hub.go](../internal/websocket/hub.go) |
| Connection handler, heartbeat, supervised run, disconnect classifier | [internal/websocket/conn.go](../internal/websocket/conn.go) |
| Query-param auth (`?token=`) | [internal/middleware/auth.go](../internal/middleware/auth.go) — `WSAuth` / `MakeWSAuthHandler` |
| Route + supervised start + broadcast wiring | [cmd/server/main.go](../cmd/server/main.go) |
| Broadcast call on save | [internal/handlers/scores.go](../internal/handlers/scores.go) — `broadcastScoresUpdated` |

- **Route:** `GET /api/v1/ws/rounds/:roundId`. Registered on `app` (not the `/api/v1` group)
  because it uses **query-param auth** — a browser can't set an `Authorization` header on a WS
  upgrade. `WSAuth` validates `?token=` (reusing the same JWKS keyfunc + `validateToken` as the
  REST middleware), rejects a non-upgrade with **426**, and a missing/invalid token with **401**
  (logging `ws.auth_failed`). No DB lookup and no round-membership check — a live-score
  subscription is read-only, matching the scorecard's public read.
- **Heartbeat + deadlines** (named constants in `conn.go`): the server pings every
  `wsPingInterval` (30s); each pong extends a `wsPongWait` (45s) read deadline, so a half-open
  socket (phone vanished with no close frame) is reaped within 45s instead of leaking. Every
  write is bounded by `wsWriteWait` (10s).
- **App-level heartbeat** (`wsHeartbeat`): on the same 30s tick the server also sends a TEXT
  frame `{"type":"ping"}`. This is *separate* from the control ping for a reason — browsers/RN
  auto-pong control frames at the protocol level, so those never surface to the client's
  `onmessage`. The text frame does, which resets the client's idle watchdog (below). Without it,
  the watchdog saw the multi-minute gaps between scoring events as "silence" and churned through
  reconnects on healthy sockets. The client treats the `ping` type as a no-op.
- **Coordinated shutdown:** a `done` channel ties the reader and writer goroutines together so
  neither leaks; whichever exits first stops the other. Both carry `defer sentry.Recover()` —
  gofiber runs the connection handler outside Fiber's recover middleware, so a panic here would
  otherwise crash the process.
- **Hub resilience:** `BroadcastToRound` is **non-blocking** (drops + logs `ws.broadcast_dropped`
  if the buffer is full, rather than stalling the HTTP handler). A slow client whose buffer fills
  is **evicted inline** from the broadcast path (`ws.send_dropped`) — *not* by sending to the
  unbuffered `unregister` channel, which would self-deadlock the hub. `RunHubSupervised` recovers
  a hub-loop panic (`ws.hub_panic`) and restarts, so one bad broadcast can't permanently kill
  live updates for everyone.

## Mobile

| Concern | Location |
|---|---|
| Pure decisions (URL, backoff, reconnect/stale gates, message parse) | [mobile/utils/liveUpdates.ts](../../mobile/utils/liveUpdates.ts) |
| The hook (socket lifecycle, AppState, NetInfo, watchdog) | [mobile/hooks/useRoundLiveUpdates.ts](../../mobile/hooks/useRoundLiveUpdates.ts) |
| Sentry reporters | [mobile/utils/sentry.ts](../../mobile/utils/sentry.ts) — `reportWsLifecycle` / `reportWsError` |

> **Web scheme gotcha.** On web a browser rejects a `ws://` upgrade from an `https://` page
> (mixed content → `SecurityError`). So `buildWsUrl` takes the hosting page's
> `location.protocol` and forces `wss://` when the page is https — the scheme follows the
> *page*, not `API_URL`, which can be an `http://` base behind Railway's TLS-terminating proxy.
> The hook passes `globalThis.location?.protocol` only when `Platform.OS === "web"`.

`useRoundLiveUpdates(roundId)` is a thin shell; all reconnect/disconnect *decisions* live in
`utils/liveUpdates.ts` (pure + unit-tested, since `hooks/` is coverage-excluded):

- **Reconnect** with capped exponential **Full Jitter** (`nextReconnectDelay`, shared rationale
  with the save retry path), giving up after `WS_RECONNECT.maxAttempts` (8) → `ws.gave_up` warning
  log (not an Issue — the poll is the floor, so the user loses nothing), then leaning on the 60s poll.
- **Catch-up:** every successful (re)connect invalidates `["scorecard", roundId]` so anything
  missed while disconnected is pulled immediately.
- **Watchdog** (`isStaleConnection`, `WS_IDLE_MS` 60s): a socket silent past the idle window is
  recycled even without an error/close event (the half-open cellular case). "Silence" means no
  *data* frame — and because the server's control pings don't reach `onmessage`, the watchdog
  keys off the app-level `{"type":"ping"}` heartbeat (every 30s). A genuinely dead link misses two
  heartbeats and is recycled; a healthy idle socket is no longer falsely churned.
- **AppState:** reconnect on foreground (mobile OSes suspend sockets in the background).
- **NetInfo:** reconnect when connectivity returns; drop the socket + pending retry when it's lost
  (don't hammer a dead radio).

## Resilience constants

| Constant | Side | Default | Rationale |
|---|---|---|---|
| `wsPingInterval` | server | 30s | Proactively probe the link; well under any idle proxy timeout. |
| `wsPongWait` | server | 45s | Read deadline; > ping interval so one dropped pong isn't fatal, but reaps a dead phone fast. |
| `wsWriteWait` | server | 10s | Bound a single stuck write. |
| `WS_RECONNECT` | mobile | base 1s, cap 30s, Full Jitter, maxAttempts 8 | Recover quickly, back off, then give up to the poll. |
| `WS_IDLE_MS` | mobile | 60s | No traffic ⇒ assume half-open and recycle. |

## Observability matrix

Every state transition emits a signal. If a transition isn't here, it isn't done — the
"how would I see this break in Sentry?" bar from [CLAUDE.md](../../CLAUDE.md).

| Event | Where | Sentry signal |
|---|---|---|
| Upgrade auth rejected | backend | `ws.auth_failed` warn log (+ 401/426) |
| Client connected | backend + mobile | `ws.connected` info log (round_id, user_id, conn_count) / breadcrumb |
| Client disconnected | backend | `ws.disconnected` info log + `reason` (client_close / pong_timeout / read_error) |
| Disconnected | mobile | `ws.disconnected` warn log (code + reason) |
| Reconnect attempt | mobile | `ws.reconnect_attempt` breadcrumb (attempt, delayMs) |
| Reconnects exhausted | mobile | `ws.gave_up` **warn log** (`event:ws.gave_up`, `error_source:ws`, `ws_state:gave_up`) → poll fallback (not an Issue — user loses nothing) |
| Slow consumer evicted | backend | `ws.send_dropped` warn log |
| Hub broadcast buffer full | backend | `ws.broadcast_dropped` warn log |
| Hub goroutine panic | backend | `ws.hub_panic` **Issue** via `sentry.Recover()` + auto-restart |
| Connection/writer panic | backend | **Issue** via `defer sentry.Recover()` |

A distributed trace already spans the mobile WS session and the score PUT it reacts to (the
SDKs continue the same `trace_id`).
