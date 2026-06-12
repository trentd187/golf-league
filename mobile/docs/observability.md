# Mobile Observability — Sentry

The React Native + Expo app uses **Sentry** as its single observability vendor across native (iOS/Android) and web. Errors, performance traces, structured logs, and session replay all flow to the same Sentry project as the backend, so a mobile action and the Fiber request it triggers share one distributed trace.

This replaced the previous custom telemetry queue (`utils/telemetry.ts` → `/api/v1/telemetry/logs`) and the OTel web tracer (`utils/tracing.ts`). Both are gone — do not reintroduce a backend log hop or a second tracing pipeline.

## Where it's wired

| Concern | Location |
|---|---|
| SDK init + option builder | [utils/sentry.ts](../utils/sentry.ts) (`initSentry`, `buildSentryOptions`) |
| Init call + navigation registration + `Sentry.wrap` | [app/_layout.tsx](../app/_layout.tsx) |
| Error boundary (recovery card + auto-capture) | [components/ErrorBoundary.tsx](../components/ErrorBoundary.tsx) |
| User context on auth changes | [hooks/useUser.ts](../hooks/useUser.ts) via `syncSentryUser` |
| Config plugin (native setup + source maps) | [app.config.js](../app.config.js) — `"@sentry/react-native"` plugin |
| Debug IDs for source maps | [metro.config.js](../metro.config.js) — `getSentryExpoConfig` |

`initSentry()` is called once at module load in `_layout.tsx`, before any component renders, so first-render errors are captured. Nothing else should call `Sentry.init`.

## Logging — `Sentry.logger.*`

Replace any "log this event" need with `Sentry.logger.info / warn / error`. Records land in **Sentry Logs** (searchable, no Issues quota); `Sentry.captureException` / thrown errors land in **Issues**.

```ts
import * as Sentry from "@sentry/react-native";

Sentry.logger.warn("OTP verification failed", {
  event: "auth.otp.error",   // stable search facet (mirrors the backend convention)
  message: error.message,
});
```

Keep an `event:` attribute with a dotted name (`auth.otp.error`, `profile.avatar.uploaded`) so logs filter cleanly per business event.

`enableLogs: true` in the init options is what makes `Sentry.logger.*` ship — without it those calls are dropped.

## User context

`hooks/useUser.ts` calls `syncSentryUser(user)` on every auth state change: it sets `{ id, email }` on sign-in/refresh and `null` on sign-out. This powers release health, per-user error filtering, and replay identification. Don't call `Sentry.setUser` elsewhere — route it through `syncSentryUser` so the lifecycle stays in one place (and stays covered by tests).

## Distributed tracing

Automatic. The SDK's fetch instrumentation injects `sentry-trace` + `baggage` headers on outgoing requests, and `sentry-go/fiber` continues the trace on the backend. `utils/api.ts` (`apiFetch`) is now a thin passthrough — it adds **no** headers. Never set `traceparent`/`sentry-trace` manually.

## Cross-platform

`@sentry/react-native` is the supported SDK for `web` too (per Expo's Sentry guide) — there is **no** separate `@sentry/react`. The only platform-specific branch is the replay integration, chosen by `Platform.OS` in `buildSentryOptions`: `browserReplayIntegration()` on web, `mobileReplayIntegration()` on native.

> `@sentry/react-native` ships native code, so it does **not** run in Expo Go. Native crash reporting needs an EAS dev build (the `development` profile already sets `developmentClient: true`). Web and the dev client work; Expo Go does not load the native module.

## Environment variables

Runtime (inlined into the JS bundle by Expo, so `EXPO_PUBLIC_` prefix required):

| Var | Notes |
|---|---|
| `EXPO_PUBLIC_SENTRY_DSN` | Project DSN. **Unset → SDK disabled**; the app runs identically with no events sent (local dev / CI / Jest). |
| `EXPO_PUBLIC_SENTRY_ENVIRONMENT` | `development` / `preview` / `production`. Falls back to `__DEV__` when unset. Set per EAS profile to match `APP_VARIANT`. |

Build-time only (source-map upload during EAS builds — never bundled into the app). The `@sentry/react-native` config plugin reads these as a fallback since no values are committed in `app.config.js`:

| Var | Notes |
|---|---|
| `SENTRY_ORG` | Sentry org slug. |
| `SENTRY_PROJECT` | Sentry project slug. |
| `SENTRY_AUTH_TOKEN` | Source-map upload token. Provide via **EAS Secrets**, never commit. |

See [.env.example](../.env.example) for the runtime placeholders.

## Sampling

Set in `buildSentryOptions`: traces and session replay are sampled at `1.0` in dev and `0.1` in prod; `replaysOnErrorSampleRate` is always `1.0`; `profilesSampleRate` is `1.0` (relative to traces). `sendDefaultPii: true` attaches user email/IP (first-party app, Sentry's recommended default).
