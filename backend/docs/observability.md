# Backend Observability — Sentry

The Go backend uses **Sentry** as its single observability vendor. Errors, distributed traces, and structured logs all flow to one place. The legacy Grafana Cloud stack (Loki / Tempo / Mimir / Pyroscope) was removed in the Sentry migration; nothing in `internal/` talks to OTel, Loki, or Pyroscope anymore.

## Boot sequence

[cmd/server/main.go](../cmd/server/main.go) initialises Sentry before the database connection so any startup error is captured:

```go
logger, sentryShutdown, err := observability.Init(cfg)
// ...
defer sentryShutdown()
slog.SetDefault(logger)
```

[internal/observability/sentry.go](../internal/observability/sentry.go) owns the SDK setup. When `SENTRY_DSN` is empty (local dev, CI), Sentry is not initialised — `logger` falls back to stdout JSON and `sentryShutdown` is a no-op. The server runs identically without credentials.

## Environment variables

| Var | Required? | Notes |
|---|---|---|
| `SENTRY_DSN` | No (omit to disable Sentry entirely) | The Sentry project DSN. |
| `SENTRY_RELEASE` | No | Git SHA tying events/stack traces to a deploy. The Dockerfile sets no build arg for it, so [`config.Load`](../internal/config/config.go) falls back to **`RAILWAY_GIT_COMMIT_SHA`** (injected automatically on every Railway deploy) when it's unset — releases tag with zero manual config. Empty only in local dev. |
| `SENTRY_TRACES_SAMPLE_RATE` | No | Override the default. Defaults: `1.0` in `development`, `0.1` elsewhere. |
| `LOG_LEVEL` | No | `debug` / `info` / `warn` / `error`. Default: `info`. Controls the minimum level emitted by `slog`. |

## Per-request hub — the only safe way to capture from a handler

`sentryfiber.New` installs a request-scoped `*sentry.Hub` on `c.Context()` for every HTTP request. Handlers and services that want to add tags, set the user, or capture an exception must use that hub — **never** the global one — so concurrent requests don't share scope.

```go
if hub := sentryfiber.GetHubFromContext(c); hub != nil {
    hub.Scope().SetTag("event_id", id.String())
    hub.CaptureException(err)
}
```

The auth middleware ([internal/middleware/auth.go](../internal/middleware/auth.go)) uses this pattern to attach the authenticated user to the hub once the JWT is verified. From that point on every event in the request inherits the user.

## Structured logging

We keep `slog` as the structured logger and route it through the official `sentry-go/slog` integration. Two sinks fan out from a single `slog.SetDefault`:

| slog level | Where it lands |
|---|---|
| `Debug`, `Info`, `Warn` | Sentry Logs (searchable; doesn't consume Issues quota) + stdout JSON |
| `Error`, `Fatal` | Sentry **Issues** (stack traces, breadcrumbs, user context) **and** Sentry **Logs** (so `level:error` is searchable in the timeline) + stdout JSON |

The `sentryslog` handler routes each record to `EventLevel` and `LogLevel` *independently*, so a level in both lists produces an Issue and a log. `Error`/`Fatal` are in both. They were once omitted from `LogLevel`, which made `level:error` queries in the Logs view return nothing even during 5xx faults — don't remove them again. (`EventLevel` is deprecated upstream in favour of driving Issues from logs; keep it until that path lands.)

Use the `*Context` variants so the active hub is attached:

```go
slog.InfoContext(c.UserContext(), "Round scheduled",
    "event_type_label", "round.created",
    "round_id", result.Round.ID.String(),
)
```

The `event_type_label` attr is a convention left over from the Loki era — it gives Sentry's "All Logs" view a stable search facet per business event.

### The fasthttp zero-copy string trap — clone at the fanout boundary

Fiber's `c.Method()`, `c.Path()`, and `c.Get(header)` return **zero-copy strings that alias fasthttp's reused request buffers** — the string header points straight into a buffer fasthttp recycles for the *next* request. The stdout JSON handler serializes each record synchronously, so it always sees the correct bytes. The `sentry-go/slog` handler does **not**: it batches records and serializes them **asynchronously**, after the buffer has been recycled. Under burst traffic the logged values mutate into garbage — observed in Sentry Logs as methods `GETT`/`DELE`/`POS` and paths like `/api/v1/meunds/…` (`/api/v1/me` overlapping the next request's `/rounds/…`). Because `RequestLogger`, `ErrorLogger`, and the idempotency middleware all log `c.Method()`/`c.Path()`, this also corrupts the **method/path tags on the 5xx→Issue path** — exactly when they matter most.

The fix lives once, at the fan-out boundary: `fanout.Handle` in [`internal/observability/sentry.go`](../internal/observability/sentry.go) deep-clones every string attr value (`strings.Clone`, recursing into groups) *before* dispatching to the handlers, so no downstream handler can alias a caller-owned buffer. This covers every current and future log producer and both sinks — do **not** re-add per-call-site cloning; that's the whack-a-mole version that misses the next producer. Whitebox-tested in `fanout_internal_test.go` (an `unsafe.String` over a byte slice, mutated after `Handle` returns, must not change the captured value).

## 5xx error logging (`middleware.ErrorLogger`)

Every handler records a server fault's root cause in `c.Locals("error_detail")` via its `write<Domain>Error` helper. [`internal/middleware/errorlog.go`](../internal/middleware/errorlog.go) is the **single consumer** of that value: registered right after `sentryfiber`, it inspects the final status after `c.Next()` and, for any 5xx, emits `slog.ErrorContext(..., "event_type_label", "http.error", ...)` — which lands as both a Sentry Issue and a searchable `level:error` / `event_type_label:http.error` log. Before it existed the legacy metrics middleware that read `error_detail` had been removed in the Sentry migration and not replaced, so non-panic 5xx faults produced **no** Issue and **no** log (only uncaught *panics* reached Sentry, via `fiberrecover`/`sentryfiber`). 4xx are expected client errors and are deliberately not logged. Keep `error_detail` populated for every 5xx in the `write*Error` helpers.

## Access + slow-request logging (`middleware.RequestLogger`)

[`internal/middleware/requestlog.go`](../internal/middleware/requestlog.go) logs one access line per request (`event_type_label:http.request`) with method, path, status, `latency_ms`, and `user_id`, to stdout (Railway deploy logs) **and** Sentry Logs. Healthy 2xx log at Info; **4xx/5xx and any request at/over the 2s slow threshold escalate to Warn** with `slow:true`. It exists because Railway's proxy `http` log stream was empty during the 7/3 502 incident, leaving no record of in-flight or slow requests while the backend went unresponsive (metrics showed the process alive but idle). It complements `ErrorLogger` (which still opens the Issue for 5xx) — this adds the latency + access trail as a searchable Log. A true hang never returns from `c.Next()` and so can't be logged here; that gap is closed by request timeouts + the `/health` DB ping.

## Business events (service-layer emit)

Business events are emitted at the **service commit site** via `slog.InfoContext(ctx, …)` — the handler passes `c.UserContext()`, so the per-request hub rides along. Emitting there (not the handler) keeps them covered by Tier 2 service tests and out of the handler coverage set. Stable facets:

| `event_type_label` | Emitted by | Fires when |
|---|---|---|
| `round.status_changed` | `RoundService.Update` | a patch transitions status (start / end / **reactivate**) — carries `old_status`, `new_status`, `actor_user_id`, `event_id` |
| `score.saved` | `ScoreService.UpsertScores` | a score upsert commits — carries `round_player_id`, `count` |
| `score.hole_stats_saved` | `ScoreService.UpsertHoleStats` | a hole-stats upsert commits — carries `round_player_id`, `count` |
| `score.handicap_blocked` | `ScoreService.UpsertScores` (**warn**) | a score save is rejected (422) because the round requires a handicap the player hasn't set — the previously-invisible UX block. Hole-stats have no such gate (asymmetry), so a player can save stats but not scores. |
| `create.recovered_by_lookup` | `handlers.LookupIdempotentResponse` | a client recovered a phantom create via `GET /idempotency/:key` (every ack was lost; the row committed). Its error path is `create.idempotency_lookup_error`. |
| `round.created` | `handlers.ScheduleEventRound` **and** `handlers.CreateEventlessRound` | a round is created. The eventless path — the "Create Round" button, the most-used create in the app — emitted **nothing** until the full-codebase audit; the single most common create was invisible. |
| `ws.sunset_hit` | `handlers.WSSunset` (**sampled**) | an old build still dialing the retired WebSocket route (410). When this goes quiet, delete the tombstone. |
| `event.status_changed` | `handlers/events.go` (handler-level, pre-existing) | an event's status changes |

The absence of `round.status_changed` and the two `score.*` events is exactly what left the 7/1 stat-save and 7/2 end→reactivate incidents with no server-side trail.

## Startup and auth failures — the events that used to have NO telemetry

These are the highest-severity events the service can have, and until the full-codebase audit they
were the *only* ones with no Sentry signal at all.

| `event_type_label` | Emitted by | Fires when |
|---|---|---|
| `server.startup_failed` | `observability.Fatal` | a dead DB, a failed migration, or an unreachable JWKS at boot |
| `server.listen_failed` | `cmd/server/main.go` | `app.Listen` fails (port in use). It used to `log.Printf` and *return* while `main` stayed parked on `<-quit` — the container reported **running and healthy with no listener**. |
| `server.panic` | `cmd/server/main.go` | the listener goroutine panicked (it had no `recover`, so a panic there died silently) |
| `auth.jwks_refresh_failed` | `middleware.LoadJWKS` | a background JWKS refresh failed. The cached keys still work, so it isn't fatal — but if it keeps failing through a key rotation, every token stops verifying. |
| `auth.user_sync_failed` | `middleware.MakeAuthHandler` (**warn**) | the JWT→DB user sync write failed. Not worth a 500 (the caller is authenticated, their data is merely stale) but it fails *forever, silently* if left unreported. |
| `health.db_unreachable` | `handlers.HealthCheck` | the DB ping failed → 503 |
| `health.jwks_empty` | `handlers.HealthCheck` | **zero verifying keys** → 503 |

**Why `observability.Fatal` exists — and why it lives in that package.** Every startup failure used
to be `log.Fatal`, which writes to stderr via the **stdlib** logger — it never touches `slog`, so it
never reached the Sentry handler. And `log.Fatal` calls `os.Exit(1)`, which skips
`defer sentryShutdown()`, so even a buffered event wouldn't flush. `observability.Fatal` does
`slog.Error` → **explicit `sentry.Flush`** → `os.Exit(1)`; the explicit flush is required precisely
*because* `os.Exit` skips defers, and it's pinned by `observability/fatal_test.go` (which asserts the
event is emitted at `ERROR` with the stable label *before* the exit — a contract you cannot verify by
watching the process, since a `log.Fatal` crashloop looks identical from outside).

**It must be the ONLY way the process dies at startup.** It lives in `internal/observability`, not
`package main`, for one reason: `middleware.newJWKSKeyfunc` must die if the JWKS is unreachable, and a
sibling of `main.fatal` would have forced it back to `log.Fatalf` — reintroducing the exact silent
crash. This is the trap the audit hit *inside its own fix*: making the JWKS boot genuinely fatal
(below) is worthless if the resulting crash is invisible. **Never call `log.Fatal`/`os.Exit`
directly** anywhere but `Init`'s own failure (which by definition can't be reported to Sentry).

**Why `/health` checks JWKS.** `keyfunc.NewDefault` builds its storage with
`NoErrorReturnFirstHTTPReq: true`, so it **returned no error** when the JWKS was unreachable: the
server booted with an **empty key set**, 401'd every authenticated request, and `/health` — which
only pinged the DB — kept answering **200**. Railway routed live traffic into a completely broken
service and never restarted it. The boot is now genuinely fatal (`NoErrorReturnFirstHTTPReq: false`,
pinned by `middleware/jwks_test.go`), and `/health` covers the case where the key set empties out
*later*, which no startup check can catch.

## Backend availability — DB pool, request timeout, `/health` (the 7/3 502 hardening)

The 7/3 incident was a ~10-minute window of proxy `502`s while Railway metrics showed the
process alive and idle (low CPU/mem) — a wedged backend, not a crash. Root cause: the DB
connection pool was **unconfigured**, so Go defaulted to UNLIMITED open connections with no
lifetime; under a live round the backend could exceed Railway Postgres's connection cap and
park every goroutine waiting for a connection. Four changes bound, recover, and expose it:

- **Bounded, recycled pool** — [`internal/database/database.go`](../internal/database/database.go)
  `Connect(dsn, PoolConfig)` applies `SetMaxOpenConns`/`SetMaxIdleConns`/`SetConnMaxLifetime`/
  `SetConnMaxIdleTime` (defaults 20 / 10 / 5m / 5m; env `DB_MAX_OPEN_CONNS`, `DB_MAX_IDLE_CONNS`,
  `DB_CONN_MAX_LIFETIME_SEC`, `DB_CONN_MAX_IDLE_TIME_SEC`). The lifetime recycles a
  Railway-proxy-dropped connection instead of handing it to a request that then hangs on it.
- **Per-request timeout** — [`internal/middleware/requesttimeout.go`](../internal/middleware/requesttimeout.go)
  on the `/api/v1` group (env `REQUEST_TIMEOUT_SEC`, default 30) bounds `c.UserContext()` so a
  hung query aborts with `context.DeadlineExceeded` → a service error → a **logged 5xx that
  reaches Sentry**, not a silent 502.
- **DB-aware `/health`** — [`internal/handlers/health.go`](../internal/handlers/health.go) pings
  the DB (2s timeout) and returns `503` + logs `event_type_label:health.db_unreachable` (an
  Issue-level event) on failure. Previously `/health` ignored the DB and returned `200` while
  every real request 502'd, so Railway kept routing into the stuck backend. **Alert on the
  `health.db_unreachable` facet, and add a Sentry uptime monitor against the `/health` URL,** so
  the next DB/pool outage pages instead of surfacing via user reports.
- **`IdleTimeout: 60s`, `ReadTimeout`/`WriteTimeout: 30s`** on the Fiber server. The Read/Write
  timeouts bound a client that dribbles a request or stops reading its response — a real risk on
  the cellular links this app runs on. They were unset for as long as the live-score WebSocket
  existed (a `WriteTimeout` kills a long-lived connection); **with the socket removed, every
  request is short and they are safe.** They complement, not replace, the per-request context
  deadline above.

## Idempotency-Key replay detection (`middleware.IdempotencyReplayLog`)

The mobile client sends a stable `Idempotency-Key` per logical write, reused across its internal retries (`mobile/utils/saveWithRetry.ts` + `utils/idempotency.ts`). [`internal/middleware/idempotency.go`](../internal/middleware/idempotency.go) has **two** stores for the two failure modes:

- **`IdempotencyReplayLog`** (in-memory, detection-only) on the idempotent **PUT** save routes (scores/hole-stats). On a repeat key within the TTL it logs `event_type_label:score.idempotent_replay` — direct evidence a "phantom save" committed and the client retried after losing the ack. It does not block or response-cache, because those endpoints are already idempotent upserts; the in-memory store (lost on restart, not shared across instances) is fine for a metric.
- **`Idempotency`** (durable, backed by the `idempotency_keys` table, migration 000024) on the non-idempotent **POST** create routes. This one **replays the original response** (status + body) on a repeat key instead of re-running the handler, so a cellular phantom create (row committed, ack lost) retried by `savePost` can't create a duplicate — and the first surviving ack still returns the new row's id. It claims the key with `INSERT … ON CONFLICT DO NOTHING` (atomic), stores the response only on 2xx (a non-2xx releases the claim so a genuine failure retries fresh), returns 409 while the original is still in flight or 422 on a key reused with a different body, and logs `event_type_label:create.idempotent_replay` on a replay hit. Pilot scope = `POST /events`, `POST /rounds`, `POST /events/:id/rounds`; remaining creates follow. Durable because it must survive a Railway restart and be shared across replicas, which the in-memory store is not.
- **`GET /api/v1/idempotency/:key`** (`handlers.LookupIdempotentResponse` over `DurableIdempotencyStore.Lookup`) — the **create-side recovery** read. The middleware above only helps when *some* ack survives; when *every* attempt's ack is lost the row still commits but `savePost` throws (the 7/7 "network error but it created"). This endpoint replays the committed response for the same key the client already holds (own-user, unexpired, committed only — else 404), so `savePost`'s `recoverByKey` recovers the new row's id and the screen navigates instead of alerting. Logs `create.recovered_by_lookup` on a hit.

## Live-score updates: `ws.sunset_hit`

The live-score WebSocket and its whole `ws.*` matrix were **removed** — it echoed every save back
to the device that made it (reflowing the scorecard mid-tap and swallowing pill presses) and never
completed a `wss` handshake on the league's cellular network. Clients poll instead; the rationale
and the client-side telemetry that replaced it are in
[`mobile/docs/live-updates.md`](../../mobile/docs/live-updates.md).

One `ws.*` event survives: **`ws.sunset_hit`** ([`internal/handlers/sunset.go`](../internal/handlers/sunset.go)),
a **sampled** (1-in-50) Info log emitted when a build still on a player's phone dials the retired
route and gets a `410 Gone`. It is sampled because an old client re-dials up to ~8×/min per open
scorecard, and it exists to answer exactly one question: **are any old builds still out there?**
When it goes quiet, delete the route and the handler.

## Background goroutines

`defer sentry.Recover()` is the one non-negotiable rule for any goroutine — without it a panic
crashes the process without ever reaching Sentry.

There are two flavors:

- **Process-level** background loops (the WS hub) are not tied to any request — just
  `defer sentry.Recover()` and capture via `sentry.CurrentHub()`.
- **Request-scoped** work that outlives the request would also clone the per-request hub so a
  captured event keeps "this request" lineage. No such async work exists today (course refresh is
  synchronous), but when you add some, use this shape:

```go
hub := sentry.CurrentHub().Clone()
go func() {
    defer sentry.Recover()
    ctx := sentry.SetHubOnContext(context.Background(), hub)
    if err := svc.SomeAsyncJob(ctx, id); err != nil {
        hub.CaptureException(err)
    }
}()
```

## Distributed tracing

Mobile and web ship `sentry-trace` + `baggage` headers on every fetch. `sentryfiber` reads them automatically and continues the same trace on the Go side. There is **no** manual `traceparent` / OTel wiring. Don't add one.

The X-Correlation-ID middleware was removed for the same reason: Sentry's `trace_id` is the cross-service correlation ID.

## Local dev

Leave `SENTRY_DSN` unset. Logs print to stdout. Errors panic locally as expected. When you need to verify a change actually lands in Sentry, set `SENTRY_DSN` and `SENTRY_ENVIRONMENT=development` in `backend/.env` and the local tracesSampleRate jumps to 1.0 automatically (`config.Load` checks `cfg.Env`).

## Why no Pyroscope replacement yet

Sentry's Go SDK (v0.46.2 at time of writing) does not expose `ProfilesSampleRate` on `ClientOptions` — Go profiling is in development upstream but not a stable surface. Mobile and web get profiling via their own SDKs; the backend will pick it up when sentry-go ships the option. Don't reach for a separate profiler — one vendor.
