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
| `SENTRY_RELEASE` | Recommended | Set to the git SHA via Docker build arg so events and stack traces are tied to a release. |
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
| `Error`, `Fatal` | Sentry Issues (with stack traces, breadcrumbs, user context) + stdout JSON |

Use the `*Context` variants so the active hub is attached:

```go
slog.InfoContext(c.UserContext(), "Round scheduled",
    "event_type_label", "round.created",
    "round_id", result.Round.ID.String(),
)
```

The `event_type_label` attr is a convention left over from the Loki era — it gives Sentry's "All Logs" view a stable search facet per business event.

## Background goroutines

The active hub is per-request and dies with the request. For work that outlives the request (course refresh, async jobs) clone the current hub onto a fresh context so any captured event still belongs to "this request" lineage:

```go
hub := sentry.CurrentHub().Clone()
go func() {
    defer sentry.Recover()
    ctx := sentry.SetHubOnContext(context.Background(), hub)
    if err := svc.RefreshCourse(ctx, id); err != nil {
        hub.CaptureException(err)
    }
}()
```

`defer sentry.Recover()` is critical — without it a panic in the goroutine crashes the process without ever reaching Sentry.

## Distributed tracing

Mobile and web ship `sentry-trace` + `baggage` headers on every fetch. `sentryfiber` reads them automatically and continues the same trace on the Go side. There is **no** manual `traceparent` / OTel wiring. Don't add one.

The X-Correlation-ID middleware was removed for the same reason: Sentry's `trace_id` is the cross-service correlation ID.

## Local dev

Leave `SENTRY_DSN` unset. Logs print to stdout. Errors panic locally as expected. When you need to verify a change actually lands in Sentry, set `SENTRY_DSN` and `SENTRY_ENVIRONMENT=development` in `backend/.env` and the local tracesSampleRate jumps to 1.0 automatically (`config.Load` checks `cfg.Env`).

## Why no Pyroscope replacement yet

Sentry's Go SDK (v0.46.2 at time of writing) does not expose `ProfilesSampleRate` on `ClientOptions` — Go profiling is in development upstream but not a stable surface. Mobile and web get profiling via their own SDKs; the backend will pick it up when sentry-go ships the option. Don't reach for a separate profiler — one vendor.
