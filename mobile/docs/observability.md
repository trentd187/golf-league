# Mobile Observability — Sentry

The React Native + Expo app uses **Sentry** as its single observability vendor across native (iOS/Android) and web. Errors, performance traces, structured logs, and session replay all flow to the same Sentry project as the backend, so a mobile action and the Fiber request it triggers share one distributed trace.

This replaced the previous custom telemetry queue (`utils/telemetry.ts` → `/api/v1/telemetry/logs`) and the OTel web tracer (`utils/tracing.ts`). Both are gone — do not reintroduce a backend log hop or a second tracing pipeline.

## Where it's wired

| Concern | Location |
|---|---|
| SDK init + option builder | [utils/sentry.ts](../utils/sentry.ts) (`initSentry`, `buildSentryOptions`) |
| TanStack query/mutation error routing | [utils/sentry.ts](../utils/sentry.ts) (`reportQueryError`, `reportMutationError`); wired to `QueryCache`/`MutationCache` in [app/_layout.tsx](../app/_layout.tsx) |
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

## TanStack Query error reporting

The `QueryClient` in `_layout.tsx` wires both caches to Sentry so failures aren't silently swallowed by per-call `onError` alerts:

- **Queries** → `QueryCache.onError: reportQueryError` — 5xx/non-HTTP errors become Issues, 4xx become warning Logs.
- **Mutations** → `MutationCache.onError: reportMutationError` — transport/network rejections (fetch rejecting even though the request may have committed server-side) are captured as Issues **tagged `error_source:mutation`, `mutation_error_kind:network`**; app-thrown errors (validation, surfaced API messages) become warning Logs to avoid noise. The global handler runs *alongside* each mutation's own `onError`, so user-facing alerts are unchanged.

To investigate cellular "phantom save" failures, filter Sentry Issues by `mutation_error_kind:network` — the exception message is the exact transport error (e.g. `Network request failed`), and breadcrumbs carry the request URL.

## Scorecard save reporting

Scorecard saves (scores, hole-stats, course handicap) do **not** go through TanStack mutations — they run through the [`savePut`](../utils/saveRequest.ts) chokepoint (see [network-saves.md](network-saves.md)). On retry exhaustion `savePut` calls `reportSaveFailure` (in [utils/sentry.ts](../utils/sentry.ts)), which captures an Issue tagged `error_source:save`, `save_kind:network|http`, `save_endpoint:<label>`, `connection_type:<type>`, with `extra` carrying `attempts`, `elapsedMs`, `httpStatus`, `cellularGeneration`, `isInternetReachable`. Each failed attempt also drops a `category:"save"` breadcrumb (warning while retries remain, error on the final attempt) via `addSaveBreadcrumb`. To triage a phantom-save recurrence, filter by `error_source:save` and read `connection_type` + `save_endpoint`.

When a transport failure is *reconciled* (read-back confirms the write landed — the phantom-save deeper fix in [network-saves.md](network-saves.md)), `savePut` instead calls `reportSaveReconciled`: an **info** message tagged `error_source:save`, `save_outcome:reconciled`. That's the client-side phantom-save counter — chart it against `reportSaveFailure` (genuinely unrecovered) to see whether last-mile loss is worsening.

## Live-score WebSocket

The round live-update WebSocket reports its lifecycle through `reportWsLifecycle` /
`reportWsError` ([utils/sentry.ts](../utils/sentry.ts)): `ws.connected` / `ws.reconnect_attempt`
breadcrumbs, a `ws.disconnected` warning log, and a `ws.gave_up` warning **log**
(`event:ws.gave_up`, `error_source:ws`) when reconnects are exhausted and the screen falls back
to the 60s poll. `gave_up` is deliberately a log, **not** an Issue — the 60s poll is the floor so
the user loses nothing, and it was pure noise on web before the `wss://` mixed-content fix; alert
on the `ws.gave_up` log facet rather than the Issues stream. Only `reportWsError` (an unexpected
socket error) opens an Issue. The hook
([hooks/useRoundLiveUpdates.ts](../hooks/useRoundLiveUpdates.ts)) and pure helpers
([utils/liveUpdates.ts](../utils/liveUpdates.ts)) plus the full cross-stack matrix are documented
in [backend/docs/websockets.md](../../backend/docs/websockets.md).

## Team-format derivations (Vegas / Best Ball)

Las Vegas and Best Ball compute entirely on-device (`utils/vegas.ts`, `utils/bestBall.ts`) with no server trace, so they're instrumented at the screen/tab boundary via [`utils/formatTelemetry.ts`](../utils/formatTelemetry.ts). `deriveFormatMatches` wraps each derivation: a thrown math bug becomes a Sentry Issue tagged `error_source:format_derivation`, `scoring_format:las_vegas|best_ball`, `format_derivation:<which>` and the tab degrades to its empty state instead of white-screening the round; `logFormatSummary` emits one `format.match_summary` log per completion-state change (not per render — ref-guarded on the scorecard). Any **new scoring format** must add the same two hooks (the [observability-in-same-commit](../../CLAUDE.md) rule).

## User context

`hooks/useUser.ts` calls `syncSentryUser(user)` on every auth state change: it sets `{ id, email }` on sign-in/refresh and `null` on sign-out. This powers release health, per-user error filtering, and replay identification. Don't call `Sentry.setUser` elsewhere — route it through `syncSentryUser` so the lifecycle stays in one place (and stays covered by tests).

## Distributed tracing

Automatic. The SDK's fetch instrumentation injects `sentry-trace` + `baggage` headers on outgoing requests, and `sentry-go/fiber` continues the trace on the backend. `utils/api.ts` (`apiFetch`) is now a thin passthrough — it adds **no** headers. Never set `traceparent`/`sentry-trace` manually.

## Cross-platform

`@sentry/react-native` is the supported SDK for `web` too (per Expo's Sentry guide) — there is **no** separate `@sentry/react`. The only platform-specific branch is **Session Replay**, gated by `Platform.OS` in `buildSentryOptions`: native gets `mobileReplayIntegration()`; **web gets no replay integration and zero replay sampling**.

> **Do not enable Session Replay on web.** The web DOM recorder (`rrweb` + `@sentry-internal/replay-canvas`) continuously snapshots the page, and on screens with many user-avatar `<img>` elements it drove the Chromium renderer into memory pressure and a `STATUS_ILLEGAL_INSTRUCTION` crash — the same failure mode as the retired OTel `PerformanceObserver` loop. Replay sampling is forced to `0` on web (rrweb records continuously to keep an on-error buffer, so the integration must be omitted, not just down-sampled). Errors, distributed traces, and logs are unaffected.

> `@sentry/react-native` ships native code, so it does **not** run in Expo Go. Native crash reporting needs an EAS dev build (the `development` profile already sets `developmentClient: true`). Web and the dev client work; Expo Go does not load the native module.

## Environment variables

Runtime (inlined into the JS bundle by Expo, so `EXPO_PUBLIC_` prefix required):

| Var | Notes |
|---|---|
| `EXPO_PUBLIC_SENTRY_DSN` | Project DSN. **Unset → SDK disabled**; the app runs identically with no events sent (local dev / CI / Jest). |
| `EXPO_PUBLIC_SENTRY_ENVIRONMENT` | `development` / `preview` / `production`. Set per EAS profile in `eas.json` (and as a Railway web-service build var) to match `APP_VARIANT`. Falls back to `__DEV__` only when unset — which previously mis-tagged preview builds as `production`. |
| `EXPO_PUBLIC_SENTRY_RELEASE` | **Web only.** The git SHA the web bundle was built from, set in `Dockerfile.web` from `RAILWAY_GIT_COMMIT_SHA`. Passed to `Sentry.init({ release })` so browser events match the source maps uploaded by that build. Leave unset on native — the SDK auto-derives the release from the native version, and overriding it would break native source-map matching. |

Build-time only (source-map upload — never bundled into the app). On **native** EAS builds the `@sentry/react-native` config plugin reads these (no values committed in `app.config.js`); on **web** the `Dockerfile.web` upload step reads the same three from Railway web-service build variables:

| Var | Notes |
|---|---|
| `SENTRY_ORG` | Sentry org slug. |
| `SENTRY_PROJECT` | Sentry project slug. |
| `SENTRY_AUTH_TOKEN` | Source-map upload token. Provide via **EAS Secrets** (native) / **Railway build variables** (web), never commit. Web upload is skipped when this is empty. |

> **Gotcha — `.npmrc` must be copied before `pnpm install` in `Dockerfile.web`.** The upload step runs `node node_modules/@sentry/cli/bin/sentry-cli sourcemaps …`. That resolves only under the **hoisted** layout (`node-linker=hoisted`), which comes from `.npmrc`. If `.npmrc` is copied only by `COPY . .` *after* install, pnpm installs symlinked and buries the transitive `@sentry/cli` (and its `@sentry/cli-linux-x64` binary) under `.pnpm/`, so the upload fails (`sentry-cli: not found`, exit 127) the moment `SENTRY_AUTH_TOKEN` is set. We invoke the shim with `node` directly, not `npx --yes @sentry/cli` — npx re-resolves the scoped package and exec's a bare `sentry-cli` off PATH.

See [.env.example](../.env.example) for the runtime placeholders.

## Build identification (releases, dist, and tags)

Every Sentry event must be pinnable to the exact build that produced it — otherwise a crash from preview build 5 is indistinguishable from build 8.

- **Native `release` / `dist`** — auto-derived by the SDK from the native version (`com.…@<version>+<buildNumber>`). `eas.json` uses `appVersionSource: "remote"` with `autoIncrement: true` on the **preview** and **production** profiles, so EAS bumps `buildNumber`/`versionCode` every build → a distinct `release`/`dist` per build **and** a fresh source-map bucket (without autoIncrement, every build reused `…@1.0.0+1`, so each build's maps overwrote the previous build's and symbolicated old crashes against wrong lines). Do **not** set `release` in `Sentry.init` on native — it would override this.
- **Web `release`** — there is no native version, so `Dockerfile.web` sets `EXPO_PUBLIC_SENTRY_RELEASE` from `RAILWAY_GIT_COMMIT_SHA` and uploads the web source maps under that release. The export **must** pass `expo export --source-maps` — otherwise only the minified `.js` ships and sentry-cli warns "no sourcemap found" (uploads the bundle but can't symbolicate). Metro's `getSentryExpoConfig` bakes matching debug ids into both the `.js` and `.js.map`, so Sentry pairs them by debug id. After upload, the `.map` files are deleted from `dist` (`find dist -name '*.map' -delete`) so we don't serve readable source to browsers — Sentry keeps its copy.
- **`build_commit` / `app_variant` tags** — `app.config.js` bakes the build's git SHA (`EAS_BUILD_GIT_COMMIT_HASH` / `RAILWAY_GIT_COMMIT_SHA` / `GITHUB_SHA`) and `APP_VARIANT` into `expoConfig.extra`; `initSentry` reads them via `resolveBuildTags` and `Sentry.setTag`s every event with `build_commit` + `app_variant`. Filter Issues by `build_commit:<sha>` to scope to one build, or `app_variant:preview` to a channel. Both are omitted in local dev / Expo Go (no build SHA), which is expected.

## Sampling

Set in `buildSentryOptions`: traces are sampled at `1.0` in dev and `0.1` in prod; `profilesSampleRate` is `1.0` (relative to traces). **Session replay is native-only** — `1.0` dev / `0.1` prod with `replaysOnErrorSampleRate` `1.0` on native, and **`0` on web** (both session and on-error — see the Cross-platform note). `sendDefaultPii: true` attaches user email/IP (first-party app, Sentry's recommended default).
