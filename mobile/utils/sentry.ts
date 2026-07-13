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
import { isAlreadyReported } from "@/utils/apiError";
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
  // Reads through apiGet/apiGetJson report themselves, with an endpoint label and a
  // connection snapshot this handler has no way to reconstruct. Filing again here would
  // double every read failure in Sentry.
  if (isAlreadyReported(error)) return;
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

// ─── Scorecard re-sync reporting ────────────────────────────────────────────────

// ScorecardMergeSkipContext describes a scorecard re-sync where the incoming server
// snapshot was degraded — it collapsed to zero scores/stats while local state still held
// data — and was therefore SKIPPED so the 3-way merge could not blank the screen. This is
// the guard for Incident B ("stats disappeared" after an end→reactivate refetch/WS push).
// Logged, not an Issue: the guard means the user lost nothing, but a rise in this facet
// points at a backend/WS path returning empty payloads, so alert on scorecard.merge_skipped.
export interface ScorecardMergeSkipContext {
  roundId: string;
  scoresDegraded: boolean;
  statsDegraded: boolean;
  localScoreCells: number;
  localStatCells: number;
}

// reportScorecardMergeSkipped records a skipped degraded re-sync as a searchable warning Log.
export function reportScorecardMergeSkipped(ctx: ScorecardMergeSkipContext): void {
  Sentry.logger.warn("scorecard re-sync skipped: incoming server snapshot was degraded", {
    event: "scorecard.merge_skipped",
    roundId: ctx.roundId,
    scores_degraded: ctx.scoresDegraded,
    stats_degraded: ctx.statsDegraded,
    local_score_cells: ctx.localScoreCells,
    local_stat_cells: ctx.localStatCells,
  });
}

// addScorecardLoadBreadcrumb records the size of each scorecard snapshot the screen syncs
// (initial load, 60s poll, hole-change refetch, or WS push). A breadcrumb — not a per-poll
// Log — so it stays cheap (1/min/user would spam Logs like the WS disconnect did) while
// still riding along on any event that fires, giving the payload trail that shows when a
// snapshot shrank toward empty right before something broke.
export function addScorecardLoadBreadcrumb(ctx: {
  roundId: string;
  players: number;
  scoreCells: number;
  statCells: number;
}): void {
  Sentry.addBreadcrumb({
    category: "scorecard",
    level: "info",
    message: `scorecard synced: ${ctx.players} players, ${ctx.scoreCells} scores, ${ctx.statCells} stats`,
    data: ctx,
  });
}

// ScorecardRefetchSource attributes WHY the scorecard query refetched. The backend's
// http.request access log counts GET /scorecard but can't tell a poll from a hole change
// or a pull-to-refresh — this source tag can, so an unexpected refetch burst stays
// attributable client-side. ("ws_open"/"ws_message" existed until the live-score socket
// was removed: its push-driven refetches were the storm that ate FIR/GIR taps.)
export type ScorecardRefetchSource = "hole_change" | "manual" | "poll";

// refetchSampleCounts samples the searchable log per source so a storm stays visible in
// Logs without flooding it (breadcrumbs alone don't surface in a Logs search). Module-level
// — a lifetime running count is fine for `count % everyNth` sampling.
const refetchSampleCounts = new Map<ScorecardRefetchSource, number>();

// addScorecardRefetchBreadcrumb records one scorecard refetch with its source. Always a
// breadcrumb (cheap, rides along on any later event); additionally a SAMPLED Log (first 3
// per source, then every 25th) so a burst is searchable as scorecard.refetch without the
// per-event flood the WS disconnect log once caused.
export function addScorecardRefetchBreadcrumb(source: ScorecardRefetchSource, roundId: string): void {
  Sentry.addBreadcrumb({
    category: "scorecard",
    level: "info",
    message: `scorecard refetch (${source})`,
    data: { source, roundId },
  });
  const n = (refetchSampleCounts.get(source) ?? 0) + 1;
  refetchSampleCounts.set(source, n);
  if (n <= 3 || n % 25 === 0) {
    Sentry.logger.info("scorecard refetch", { event: "scorecard.refetch", source, roundId, count: n });
  }
}

// ─── Read (GET) reporting ───────────────────────────────────────────────────────
//
// The write path has had failure telemetry since the phantom-save work; the read path
// had NONE — every queryFn was a bare fetch with no timeout, retry, or signal, so a read
// that hung on a flaky radio was indistinguishable from a frozen app. These mirror the
// save reporters so a read failure is as diagnosable as a write failure.

// ReadFailureContext describes a read that exhausted its retries. connection* come from
// snapshotConnection() and are read lazily, only on failure.
export interface ReadFailureContext {
  label: string; // stable endpoint label, e.g. "scorecard" — becomes read_endpoint
  attempts: number;
  elapsedMs: number;
  httpStatus?: number; // undefined ⇒ transport failure (never got a response)
  connectionType?: string;
  cellularGeneration?: string | null;
  isInternetReachable?: boolean | null;
}

// readKind classifies a read failure the same way saveKind classifies a write: an HTTP
// status means the server answered and rejected us; no status means the request never
// completed a round trip (timeout, radio drop, DNS) — the cellular last-mile mode.
function readKind(ctx: ReadFailureContext): "http" | "network" {
  return ctx.httpStatus === undefined ? "network" : "http";
}

// reportReadFailure records a read that failed after all retries.
//
// Routing is deliberately asymmetric: a 5xx is a real backend defect → Sentry Issue. A
// transport failure or a 4xx is NOT an Issue — on cellular a dropped GET is expected and
// the query will simply retry or repaint on the next poll, so an Issue per occurrence
// would recreate exactly the alert flood the WebSocket used to produce. Those land in
// searchable Logs (event:read.failed) instead; alert on the facet, not the event.
export function reportReadFailure(error: unknown, ctx: ReadFailureContext): void {
  const kind = readKind(ctx);
  const isServerFault = ctx.httpStatus !== undefined && ctx.httpStatus >= 500;

  if (isServerFault && error instanceof Error) {
    Sentry.captureException(error, {
      tags: {
        error_source: "read",
        read_kind: kind,
        read_endpoint: ctx.label,
        connection_type: ctx.connectionType ?? "unknown",
      },
      extra: { ...ctx },
    });
    return;
  }

  Sentry.logger.warn("read failed after retries", {
    event: "read.failed",
    error_source: "read",
    read_kind: kind,
    read_endpoint: ctx.label,
    message: error instanceof Error ? error.message : String(error),
    ...ctx,
  });
}

// addReadBreadcrumb records one failed read attempt before its retry (nextDelayMs null on
// the final attempt). Breadcrumbs are free until an event fires, and they're what turns a
// later Issue into a story: "three reads timed out, then the save failed."
export function addReadBreadcrumb(ctx: {
  label: string;
  attempt: number;
  nextDelayMs: number | null;
  message: string;
}): void {
  Sentry.addBreadcrumb({
    category: "read",
    level: ctx.nextDelayMs === null ? "error" : "warning",
    message: `read ${ctx.label} attempt ${ctx.attempt} failed: ${ctx.message}`,
    data: ctx,
  });
}

// ─── Upload reporting ───────────────────────────────────────────────────────────

// reportUploadFailure captures a failed binary upload (avatar → Supabase Storage) as an
// Issue tagged error_source:upload. Unlike a read, an upload is user-initiated and its
// failure is immediately visible to them, so it warrants an Issue: if it breaks, someone
// is staring at a spinner wondering why their photo won't save.
export function reportUploadFailure(
  error: unknown,
  ctx: { label: string; attempts: number; bytes?: number },
): void {
  Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
    tags: { error_source: "upload", upload_target: ctx.label },
    extra: { ...ctx },
  });
}

// ─── Poll gating ────────────────────────────────────────────────────────────────

// reportPollDeferred records that a polled scorecard snapshot was HELD rather than merged,
// because the user was mid-interaction (see utils/pollGate.ts). This is the successor to
// the WS storm signals: it proves the guard is doing its job and bounds how long a peer's
// score can sit unapplied. Sampled — during active scoring this can fire often, and the
// whole point of the change is to stop flooding Sentry.
let pollDeferredCount = 0;
export function reportPollDeferred(ctx: {
  roundId: string;
  inFlightSaves: number;
  msSinceLastInteraction: number;
}): void {
  Sentry.addBreadcrumb({
    category: "scorecard",
    level: "info",
    message: "polled snapshot deferred (user is editing)",
    data: ctx,
  });
  pollDeferredCount += 1;
  if (pollDeferredCount <= 3 || pollDeferredCount % 25 === 0) {
    Sentry.logger.info("polled scorecard snapshot deferred while the user was editing", {
      event: "poll.deferred",
      count: pollDeferredCount,
      ...ctx,
    });
  }
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
