// utils/sentry.ts
// Single Sentry initialisation module for the Golf League app. Imported once from
// app/_layout.tsx via initSentry(); nothing else should call Sentry.init.
//
// Sentry is the app's only observability vendor — errors, distributed traces,
// structured logs (Sentry.logger.*), and session replay all flow here. It replaces
// the previous custom telemetry queue (utils/telemetry.ts) and OTel web tracer
// (utils/tracing.ts), both removed in the Sentry migration.
//
// Cross-platform: this module is safe on native and web. The replay integration is
// the only platform-specific piece — native uses the canvas recorder, web uses the
// DOM recorder — so it is chosen by Platform.OS. Everything else is shared.
//
// When EXPO_PUBLIC_SENTRY_DSN is unset (local dev / CI / Jest) the SDK initialises
// with an undefined DSN and silently sends nothing — the app runs identically.
//
// The config-building logic is split into small pure functions (resolveSentryEnvironment,
// buildSentryOptions) so it stays inside the Jest coverage set per the extract-first
// rule; initSentry itself is the only side-effecting entry point.

import * as Sentry from "@sentry/react-native";
import { Platform } from "react-native";
import Constants from "expo-constants";

// navigationIntegration is created once at module load so app/_layout.tsx can
// register it with the expo-router navigation container. It turns route changes
// into breadcrumbs and emits screen-load (TTID) spans.
export const navigationIntegration = Sentry.reactNavigationIntegration({
  // Time-to-initial-display instrumentation needs the native module, which is not
  // present in Expo Go. Constants.appOwnership === "expo" only inside Expo Go, so
  // enable TTID everywhere else (dev client / standalone builds).
  enableTimeToInitialDisplay: Constants.appOwnership !== "expo",
});

// resolveSentryEnvironment picks the environment tag attached to every event.
// Prefer the explicit EXPO_PUBLIC_SENTRY_ENVIRONMENT (set per EAS profile to
// development | preview | production); fall back to __DEV__ when it is unset.
export function resolveSentryEnvironment(
  explicit: string | undefined,
  isDev: boolean,
): string {
  if (explicit && explicit.length > 0) return explicit;
  return isDev ? "development" : "production";
}

// resolveBuildTags maps the build metadata baked into app.config.js's `extra` block
// (Constants.expoConfig.extra at runtime) into stable Sentry tags so every event can be
// pinned to the exact build that produced it. `build_commit` is the git SHA of the build
// (the EAS/Railway/CI commit), `app_variant` is the EAS profile (development|preview|
// production). Pure and tolerant of a missing/partial `extra` (local dev, Expo Go) so it
// stays inside the Jest coverage set; absent values are simply omitted.
export function resolveBuildTags(
  extra: Record<string, unknown> | undefined | null,
): Record<string, string> {
  const tags: Record<string, string> = {};
  const commitSha = extra?.commitSha;
  const appVariant = extra?.appVariant;
  if (typeof commitSha === "string" && commitSha.length > 0) {
    tags.build_commit = commitSha;
  }
  if (typeof appVariant === "string" && appVariant.length > 0) {
    tags.app_variant = appVariant;
  }
  return tags;
}

// buildSentryOptions assembles the Sentry.init options object. Pure (it does not
// call Sentry.init) so it can be unit-tested against a mocked SDK.
export function buildSentryOptions(opts: {
  dsn: string | undefined;
  environment: string;
  isDev: boolean;
  platformOS: string;
  release?: string;
}): Sentry.ReactNativeOptions {
  const { dsn, environment, isDev, platformOS, release } = opts;
  const isWeb = platformOS === "web";

  // Preview is our pre-release league-testing channel: low volume, and event days
  // (Vegas/Best Ball rounds) are exactly when we need every trace to debug the
  // cellular save path. So preview gets full trace sampling like dev; only the
  // high-volume production build is throttled to stay within quota.
  // NOTE: we deliberately do NOT add a beforeSend/ignoreErrors filter for abort
  // ("Aborted"/AbortError) noise — a rise in aborts is itself a signal (e.g. the
  // per-attempt save timeout firing more often), so we keep that visible.
  const fullTrace = isDev || environment === "preview";

  // Native replay sampling: full in dev for verification, 10% of sessions in prod.
  // Web is forced to 0 below so rrweb never records (see the integration note below).
  const nativeSessionReplayRate = isDev ? 1.0 : 0.1;

  return {
    dsn,
    environment,
    // Spread `release` only when provided. On native the SDK auto-derives the release
    // from the build's native version (e.g. com.…@1.0.0+12), and overriding it would
    // break source-map matching — so we leave it undefined there. Web has no native
    // version, so the Dockerfile.web export sets EXPO_PUBLIC_SENTRY_RELEASE to the git
    // SHA (matching the maps uploaded by that build) and passes it through here.
    ...(release ? { release } : {}),
    // First-party app — attach user email/IP. Sentry's recommended default.
    sendDefaultPii: true,
    // Route Sentry.logger.* records to Sentry Logs (searchable, no Issues quota).
    enableLogs: true,
    // Full trace sampling in dev + preview for easy verification; 10% in production.
    tracesSampleRate: fullTrace ? 1.0 : 0.1,
    // Relative to tracesSampleRate — profile every sampled transaction.
    profilesSampleRate: 1.0,
    // Replay sampling applies to native only; web records nothing (see below).
    replaysSessionSampleRate: isWeb ? 0 : nativeSessionReplayRate,
    replaysOnErrorSampleRate: isWeb ? 0 : 1.0,
    integrations: [
      navigationIntegration,
      // Session Replay is native-only. The web DOM recorder (rrweb + replay-canvas)
      // continuously snapshots the page; on screens with many user-avatar <img>
      // elements it drove the Chromium renderer into memory pressure and a
      // STATUS_ILLEGAL_INSTRUCTION crash — the same failure mode as the retired OTel
      // PerformanceObserver loop. Omit it on web entirely; the zero replay sample
      // rates above ensure rrweb never records. Native keeps the canvas recorder,
      // which is well-behaved.
      ...(isWeb ? [] : [Sentry.mobileReplayIntegration()]),
    ],
  };
}

// syncSentryUser attaches (or clears) the Sentry user context so every event is
// attributed to the signed-in user — powering release health, per-user error
// filtering, and replay identification. Pass null on sign-out. Accepts a minimal
// shape rather than Supabase's User type to avoid coupling this module to Supabase.
export function syncSentryUser(
  user: { id: string; email?: string } | null,
): void {
  if (user) {
    Sentry.setUser({ id: user.id, email: user.email });
  } else {
    Sentry.setUser(null);
  }
}

// reportQueryError routes a TanStack Query error to the right Sentry channel:
// 5xx and non-HTTP errors are captured as Issues; 4xx responses are expected
// client errors, so they become a warning log rather than an Issue. Extracted
// here (rather than inline in the QueryCache handler) so app/_layout.tsx — which
// is excluded from coverage — carries no logic.
export function reportQueryError(error: unknown): void {
  if (error instanceof Response) {
    if (error.status >= 500) {
      Sentry.captureException(
        new Error(`API ${error.status} error: ${error.url}`),
      );
    } else if (error.status >= 400) {
      Sentry.logger.warn("API client error", {
        status: error.status,
        url: error.url,
      });
    }
    return;
  }
  if (error instanceof Error) {
    Sentry.captureException(error);
  }
}

// NETWORK_ERROR_RE matches the messages fetch produces when the transport fails
// rather than the server returning an error body — i.e. the request may have
// reached the backend (and even committed) while the client never saw a response.
// This is the signature of the cellular "phantom failure → duplicate write" bug:
// the user sees a save error, retries, and a non-idempotent POST runs twice.
// Covers the React Native (Android okhttp / iOS) and web wordings.
const NETWORK_ERROR_RE =
  /network request failed|failed to fetch|load failed|networkerror|network connection|timed?\s?out|timeout|unexpected end of stream|stream was reset|connection reset|connection abort|cancell?ed|aborted/i;

// mutationKeyLabel renders an optional TanStack mutationKey as a short string for
// Sentry context. Most mutations omit the key, so undefined is the common case.
function mutationKeyLabel(mutationKey: unknown): string | undefined {
  if (mutationKey === undefined) return undefined;
  try {
    return JSON.stringify(mutationKey);
  } catch {
    return String(mutationKey);
  }
}

// reportMutationError routes a TanStack Query *mutation* error to Sentry. Unlike
// queries, mutation failures were previously invisible to Sentry (no MutationCache
// handler existed), which is why the cellular save failures left no telemetry.
//
// Transport/network rejections are captured as Issues (tagged for filtering) because
// they are the phantom-failure path we are hunting. App-thrown errors (validation,
// or an API error body already surfaced to the user) become a warning Log instead
// of an Issue — they are still searchable in Sentry but do not create noise.
//
// Mutations in this app always reject with an Error (their mutationFn converts a
// non-ok Response into one before throwing), so there is no Response branch here.
export function reportMutationError(error: unknown, mutationKey?: unknown): void {
  if (!(error instanceof Error)) return;

  const keyLabel = mutationKeyLabel(mutationKey);
  if (NETWORK_ERROR_RE.test(error.message)) {
    Sentry.captureException(error, {
      tags: { error_source: "mutation", mutation_error_kind: "network" },
      extra: { mutationKey: keyLabel },
    });
  } else {
    Sentry.logger.warn("Mutation error (non-network)", {
      message: error.message,
      mutationKey: keyLabel,
    });
  }
}

// SaveFailureContext carries the diagnostic data captured when a scorecard save
// exhausts all retries. connection_* fields come from a NetInfo snapshot taken
// lazily on failure (see utils/saveRequest.ts) — the cellular phantom-save bug is
// the reason we want connection type / generation alongside attempts + elapsed.
export interface SaveFailureContext {
  label: string; // save endpoint label: "scores" | "hole-stats" | "handicap"
  attempts: number; // how many attempts ran before giving up
  elapsedMs: number; // wall-clock time across all attempts
  httpStatus?: number; // set only when the final failure was an HTTP non-2xx
  connectionType?: string; // NetInfo type: "cellular" | "wifi" | "none" | "unknown" | …
  cellularGeneration?: string | null; // "2g" | "3g" | "4g" | "5g" when on cellular
  isInternetReachable?: boolean | null;
}

// reportSaveFailure routes an exhausted scorecard save to Sentry as an Issue. This
// is the telemetry the raw-fetch save paths previously lacked (they bypassed
// reportMutationError). An HTTP non-2xx that survived every retry is a real server
// rejection (save_kind "http"); a transport reject / abort-timeout is the lost-response
// phantom path we are hunting (save_kind "network"). Tags are filterable in Sentry;
// the connection + attempt detail rides in `extra`.
export function reportSaveFailure(error: unknown, ctx: SaveFailureContext): void {
  if (!(error instanceof Error)) return;

  const kind =
    ctx.httpStatus !== undefined
      ? "http"
      : NETWORK_ERROR_RE.test(error.message)
        ? "network"
        : "unknown";

  Sentry.captureException(error, {
    tags: {
      error_source: "save",
      save_kind: kind,
      save_endpoint: ctx.label,
      connection_type: ctx.connectionType ?? "unknown",
    },
    extra: {
      attempts: ctx.attempts,
      elapsedMs: ctx.elapsedMs,
      httpStatus: ctx.httpStatus,
      cellularGeneration: ctx.cellularGeneration,
      isInternetReachable: ctx.isInternetReachable,
    },
  });
}

// SaveReconciledContext describes a save that exhausted every retry with a transport
// failure but whose data was found already committed on the server — a confirmed
// cellular "phantom save" (write landed, last-mile ack lost). It is the explicit
// server-confirmed counter the raw save paths never produced; the SRE sweep flagged
// the absence of any such metric as a visibility gap.
export interface SaveReconciledContext {
  label: string;
  attempts: number; // retries that ran before the transport gave up
  elapsedMs: number; // wall-clock across all attempts
  connectionType?: string;
  cellularGeneration?: string | null;
}

// reportSaveReconciled records a recovered phantom save as a structured Sentry LOG (not a
// captureMessage — the user lost nothing, so it shouldn't open an Issue). It lands in
// searchable Logs where save_outcome:reconciled charts phantom saves the read-back rescued
// vs. reportSaveFailure's genuine, unrecovered failures, so we can tell whether the cellular
// last-mile loss is getting worse — without polluting the Issues stream.
export function reportSaveReconciled(ctx: SaveReconciledContext): void {
  Sentry.logger.info("scorecard save reconciled after transport failure", {
    event: "save.reconciled",
    error_source: "save",
    save_outcome: "reconciled",
    save_endpoint: ctx.label,
    connection_type: ctx.connectionType ?? "unknown",
    attempts: ctx.attempts,
    elapsedMs: ctx.elapsedMs,
    cellularGeneration: ctx.cellularGeneration,
  });
}

// ─── Create (non-idempotent POST) reporting ─────────────────────────────────────
//
// Creates (event, round, group, member, guest, team) are the non-idempotent half of
// the cellular phantom-write bug: the row commits but the ack is lost, the client shows
// "Could not create …", and a naive retry would double-create. savePost now retries
// safely (the backend dedupes via Idempotency-Key) and routes its telemetry here. A
// distinct error_source:"create" keeps these filterable apart from scorecard saves.

// CreateFailureContext mirrors SaveFailureContext's shape (so savePost can build one
// context for both), labelled by create endpoint instead of save endpoint.
export interface CreateFailureContext {
  label: string; // create endpoint: "event" | "round" | "group" | "guest" | "team" | …
  attempts: number;
  elapsedMs: number;
  httpStatus?: number; // set only when the final failure was an HTTP non-2xx
  connectionType?: string;
  cellularGeneration?: string | null;
  isInternetReachable?: boolean | null;
}

// reportCreateFailure routes an exhausted create to Sentry as an Issue. An HTTP non-2xx
// that survived every retry is a real server rejection (create_kind "http"); a transport
// reject / abort-timeout is the lost-response phantom path (create_kind "network").
export function reportCreateFailure(error: unknown, ctx: CreateFailureContext): void {
  if (!(error instanceof Error)) return;

  const kind =
    ctx.httpStatus !== undefined
      ? "http"
      : NETWORK_ERROR_RE.test(error.message)
        ? "network"
        : "unknown";

  Sentry.captureException(error, {
    tags: {
      error_source: "create",
      create_kind: kind,
      create_endpoint: ctx.label,
      connection_type: ctx.connectionType ?? "unknown",
    },
    extra: {
      attempts: ctx.attempts,
      elapsedMs: ctx.elapsedMs,
      httpStatus: ctx.httpStatus,
      cellularGeneration: ctx.cellularGeneration,
      isInternetReachable: ctx.isInternetReachable,
    },
  });
}

// CreateReconciledContext describes a create that exhausted every retry with a transport
// failure but whose row was confirmed already committed on the server — a recovered
// phantom create. Used only when a savePost caller supplies a read-back reconcile.
export interface CreateReconciledContext {
  label: string;
  attempts: number;
  elapsedMs: number;
  connectionType?: string;
  cellularGeneration?: string | null;
}

// reportCreateReconciled records a recovered phantom create as a structured Sentry LOG (the
// user lost nothing, so no Issue). create_outcome:reconciled charts phantoms the retry/replay
// rescued vs. reportCreateFailure's genuine, unrecovered failures — in searchable Logs, not
// the Issues stream.
export function reportCreateReconciled(ctx: CreateReconciledContext): void {
  Sentry.logger.info("create reconciled after transport failure", {
    event: "create.reconciled",
    error_source: "create",
    create_outcome: "reconciled",
    create_endpoint: ctx.label,
    connection_type: ctx.connectionType ?? "unknown",
    attempts: ctx.attempts,
    elapsedMs: ctx.elapsedMs,
    cellularGeneration: ctx.cellularGeneration,
  });
}

// addCreateBreadcrumb records one failed create attempt so a later success (which emits
// no Issue) still leaves the trail of transient failures on whatever event the session
// produces. Wired from savePost's withRetry onAttemptError.
export function addCreateBreadcrumb(ctx: SaveBreadcrumbContext): void {
  Sentry.addBreadcrumb({
    category: "create",
    level: ctx.nextDelayMs === null ? "error" : "warning",
    message: `create ${ctx.label} attempt ${ctx.attempt} failed: ${ctx.message}`,
    data: {
      label: ctx.label,
      attempt: ctx.attempt,
      nextDelayMs: ctx.nextDelayMs,
    },
  });
}

// ─── Live-update WebSocket reporting ────────────────────────────────────────────

// WsLifecycleContext carries the per-event detail for the live-score WebSocket. The
// socket is an enhancement over the 60s scorecard poll, so these signals exist to tell
// whether the realtime layer is healthy — and the poll guarantees no regression if not.
export interface WsLifecycleContext {
  roundId: string;
  attempt?: number; // reconnect attempt number (reconnect_attempt / gave_up)
  delayMs?: number; // scheduled backoff before the next attempt
  code?: number; // WebSocket close code (disconnected)
  reason?: string; // close/disconnect reason string
}

// reportWsLifecycle routes a WebSocket lifecycle event to the right Sentry channel —
// the mobile half of the WS observability matrix (backend/docs/websockets.md). Every
// transition stays out of the Issues stream: healthy ones are breadcrumbs, and the
// unhealthy "gave_up" (reconnects exhausted → falling back to the poll) is a searchable
// warning *log* rather than an Issue. The user loses nothing when this fires — the 60s
// poll is the floor — so it doesn't deserve an Issue; on web it was pure noise (the
// now-fixed ws:// mixed-content bug), on mobile it's a benign cellular drop. Alert on the
// `ws.gave_up` log facet instead.
export function reportWsLifecycle(
  event: "connected" | "reconnect_attempt" | "disconnected" | "gave_up",
  ctx: WsLifecycleContext,
): void {
  switch (event) {
    case "connected":
      Sentry.addBreadcrumb({
        category: "ws",
        level: "info",
        message: `ws connected (round ${ctx.roundId})`,
        data: { roundId: ctx.roundId },
      });
      break;
    case "reconnect_attempt":
      Sentry.addBreadcrumb({
        category: "ws",
        level: "warning",
        message: `ws reconnect attempt ${ctx.attempt}`,
        data: { roundId: ctx.roundId, attempt: ctx.attempt, delayMs: ctx.delayMs },
      });
      break;
    case "disconnected":
      Sentry.logger.warn("ws disconnected", {
        event: "ws.disconnected",
        roundId: ctx.roundId,
        code: ctx.code,
        reason: ctx.reason,
      });
      break;
    case "gave_up":
      Sentry.logger.warn(
        "WebSocket gave up reconnecting; falling back to the scorecard poll",
        {
          event: "ws.gave_up",
          error_source: "ws",
          ws_state: "gave_up",
          roundId: ctx.roundId,
          attempts: ctx.attempt,
        },
      );
      break;
  }
}

// reportWsError captures an unexpected WebSocket error (e.g. a message that couldn't be
// handled) as a Sentry Issue tagged error_source:ws. Non-Error values are ignored so a
// stray reject doesn't create a useless Issue.
export function reportWsError(error: unknown, roundId: string): void {
  if (!(error instanceof Error)) return;
  Sentry.captureException(error, {
    tags: { error_source: "ws" },
    extra: { roundId },
  });
}

// SaveBreadcrumbContext describes one failed save attempt (before a retry, or the
// final give-up when nextDelayMs is null).
export interface SaveBreadcrumbContext {
  label: string;
  attempt: number; // 1-based attempt number that just failed
  nextDelayMs: number | null; // backoff before the next try; null on the final attempt
  message: string; // the attempt's error message
}

// addSaveBreadcrumb records a per-attempt breadcrumb so that, if a later attempt
// succeeds (no Issue is captured), the trail of transient failures is still visible
// on whatever event the session does produce. Wired from withRetry's onAttemptError.
export function addSaveBreadcrumb(ctx: SaveBreadcrumbContext): void {
  Sentry.addBreadcrumb({
    category: "save",
    level: ctx.nextDelayMs === null ? "error" : "warning",
    message: `save ${ctx.label} attempt ${ctx.attempt} failed: ${ctx.message}`,
    data: {
      label: ctx.label,
      attempt: ctx.attempt,
      nextDelayMs: ctx.nextDelayMs,
    },
  });
}

// addStatFocusBreadcrumb records that an advanced-stat input received focus, with whether
// it was editable at the time. The scorecard's only *typed* stat is Putts (FIR/GIR/OB are
// taps), so a "couldn't edit putts" report is ambiguous between a real editability bug and
// a keyboard-reachability issue (the field sitting under the on-screen keyboard). This
// breadcrumb lands on the session replay and any captured event, so the trail shows whether
// the field actually focused and its editable state — distinguishing the two. Info level:
// it never opens an Issue on its own.
export function addStatFocusBreadcrumb(field: string, editable: boolean): void {
  Sentry.addBreadcrumb({
    category: "scorecard",
    level: "info",
    message: `stat ${field} focused`,
    data: { field, editable },
  });
}

// initSentry initialises the SDK once at app start. Reads runtime config from
// EXPO_PUBLIC_* env vars (inlined into the bundle by Expo at build time) plus the build
// metadata baked into app.config.js's `extra` block (Constants.expoConfig.extra), and
// pins every event to the build that produced it via build_commit / app_variant tags.
export function initSentry(): void {
  Sentry.init(
    buildSentryOptions({
      dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
      environment: resolveSentryEnvironment(
        process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT,
        __DEV__,
      ),
      isDev: __DEV__,
      platformOS: Platform.OS,
      // Native: undefined → SDK keeps its auto-derived release. Web: the export sets
      // this to the git SHA so events match the uploaded source maps.
      release: process.env.EXPO_PUBLIC_SENTRY_RELEASE,
    }),
  );

  // Tag every subsequent event with the exact build (git SHA + EAS variant). Done after
  // init so the tags ride on all events; resolveBuildTags omits anything absent.
  const buildTags = resolveBuildTags(
    Constants.expoConfig?.extra as Record<string, unknown> | undefined,
  );
  for (const [key, value] of Object.entries(buildTags)) {
    Sentry.setTag(key, value);
  }
}
