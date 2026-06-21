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

## 5xx error logging (`middleware.ErrorLogger`)

Every handler records a server fault's root cause in `c.Locals("error_detail")` via its `write<Domain>Error` helper. [`internal/middleware/errorlog.go`](../internal/middleware/errorlog.go) is the **single consumer** of that value: registered right after `sentryfiber`, it inspects the final status after `c.Next()` and, for any 5xx, emits `slog.ErrorContext(..., "event_type_label", "http.error", ...)` — which lands as both a Sentry Issue and a searchable `level:error` / `event_type_label:http.error` log. Before it existed the legacy metrics middleware that read `error_detail` had been removed in the Sentry migration and not replaced, so non-panic 5xx faults produced **no** Issue and **no** log (only uncaught *panics* reached Sentry, via `fiberrecover`/`sentryfiber`). 4xx are expected client errors and are deliberately not logged. Keep `error_detail` populated for every 5xx in the `write*Error` helpers.

## Idempotency-Key replay detection (`middleware.IdempotencyReplayLog`)

The mobile client sends a stable `Idempotency-Key` per logical write, reused across its internal retries (`mobile/utils/saveWithRetry.ts` + `utils/idempotency.ts`). [`internal/middleware/idempotency.go`](../internal/middleware/idempotency.go) has **two** stores for the two failure modes:

- **`IdempotencyReplayLog`** (in-memory, detection-only) on the idempotent **PUT** save routes (scores/hole-stats). On a repeat key within the TTL it logs `event_type_label:score.idempotent_replay` — direct evidence a "phantom save" committed and the client retried after losing the ack. It does not block or response-cache, because those endpoints are already idempotent upserts; the in-memory store (lost on restart, not shared across instances) is fine for a metric.
- **`Idempotency`** (durable, backed by the `idempotency_keys` table, migration 000024) on the non-idempotent **POST** create routes. This one **replays the original response** (status + body) on a repeat key instead of re-running the handler, so a cellular phantom create (row committed, ack lost) retried by `savePost` can't create a duplicate — and the first surviving ack still returns the new row's id. It claims the key with `INSERT … ON CONFLICT DO NOTHING` (atomic), stores the response only on 2xx (a non-2xx releases the claim so a genuine failure retries fresh), returns 409 while the original is still in flight or 422 on a key reused with a different body, and logs `event_type_label:create.idempotent_replay` on a replay hit. Pilot scope = `POST /events`, `POST /rounds`, `POST /events/:id/rounds`; remaining creates follow. Durable because it must survive a Railway restart and be shared across replicas, which the in-memory store is not.

## WebSocket live-score observability

The live-score WebSocket emits its own `ws.*` events (auth rejections, connect/disconnect with
reason, slow-consumer/broadcast drops, hub-panic Issues). The full matrix and the supervised-run
+ heartbeat design live in [websockets.md](websockets.md).

## Background goroutines

`defer sentry.Recover()` is the one non-negotiable rule for any goroutine — without it a panic
crashes the process without ever reaching Sentry. The process-level WebSocket hub loop and each
WS connection goroutine follow exactly this (supervised restart on the hub loop) — see
[websockets.md](websockets.md).

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
