// utils/saveRequest.ts
// The single instrumented chokepoint for scorecard PUT saves (scores, hole-stats,
// course handicap). Every save goes through savePut so that all four formerly-raw
// fetch sites get, uniformly:
//
//   1. A bounded per-attempt timeout (AbortController) — a request stuck on a dead
//      okhttp keep-alive socket fails fast so the *next* retry opens a fresh
//      connection. (utils/api.ts has no timeout; the raw saves had none either.)
//   2. Capped exponential backoff with Full Jitter (utils/withRetry.ts) — research-
//      backed spacing that decorrelates retries from the network's recovery cycle and
//      varies connection timing to evict the stale socket. Fixed-delay retries reused
//      the same poisoned connection and failed identically.
//   3. A throw on !res.ok so HTTP errors are retried and surfaced (fixes the handicap
//      handleSaveHandicaps silent-success-on-5xx bug).
//   4. Telemetry on exhaustion (reportSaveFailure) + per-attempt breadcrumbs — the
//      raw saves bypassed reportMutationError and emitted no Sentry event, which is
//      why the cellular "phantom save" failures left no Issue.
//
// Background: a write commits server-side but the response is lost on the last-mile
// cellular hop, so fetch rejects and the client shows a false failure. Backend +
// Railway edge were exonerated (100% 2xx). See mobile/docs/network-saves.md and the
// project memory project-cellular-phantom-saves.
//
// All side-effecting collaborators (fetch, NetInfo, the Sentry reporters, sleep, rng,
// clock) are injectable so this module is fully unit-tested while the calling screen
// (app/scorecard/[roundId].tsx) stays coverage-excluded — the extract-first rule.

import { runSaveWithRetry, type RetryProfile } from "@/utils/saveWithRetry";
import { type NetInfoStateLike } from "@/utils/connectionSnapshot";
import {
  reportSaveFailure,
  reportSaveReconciled,
  addSaveBreadcrumb,
  type SaveFailureContext,
  type SaveReconciledContext,
} from "@/utils/sentry";

// RetryProfile (the backoff knobs + per-attempt timeout) now lives in the shared core
// (utils/saveWithRetry.ts); re-exported here so existing importers are unaffected.
export type { RetryProfile };

// BACKGROUND_SAVE — scores & hole-stats. Invisible/optimistic, so a longer total
// budget maximizes *silent* success (fewer false errors surfaced to the player).
export const BACKGROUND_SAVE: RetryProfile = {
  maxAttempts: 5,
  baseMs: 500,
  capMs: 8000,
  timeoutMs: 15000,
};

// FOREGROUND_SAVE — course-handicap saves. They show an ActivityIndicator and disable
// the button, so a shorter budget avoids a minute-long spinner; the user can re-tap.
export const FOREGROUND_SAVE: RetryProfile = {
  maxAttempts: 3,
  baseMs: 500,
  capMs: 4000,
  timeoutMs: 12000,
};

// SavePutOptions configure one savePut call. url/token/body/label are the request;
// retry picks a profile; the rest are injectable collaborators (defaults wire the
// real implementations) so tests run without a network, NetInfo, Sentry, or timers.
export interface SavePutOptions {
  url: string;
  token: string;
  body: unknown;
  label: string; // "scores" | "hole-stats" | "handicap"
  retry?: RetryProfile;
  // reconcile, when provided, is invoked only after every retry has failed. It
  // should read authoritative server state and resolve true when the write is
  // already committed there (a cellular phantom save — ack lost, data safe), so
  // savePut can suppress the false failure. Resolving false (or throwing) means the
  // write genuinely did not land and the error surfaces as before. See
  // utils/saveReconcile.ts and mobile/docs/network-saves.md.
  reconcile?: () => Promise<boolean>;
  // Injectables (production defaults applied below):
  fetchImpl?: typeof fetch;
  genKey?: () => string; // mints the Idempotency-Key; default is a v4 UUID
  netInfoFetch?: () => Promise<NetInfoStateLike>;
  report?: (error: unknown, ctx: SaveFailureContext) => void;
  reportReconciled?: (ctx: SaveReconciledContext) => void;
  breadcrumb?: typeof addSaveBreadcrumb;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  now?: () => number;
}

// savePut performs an idempotent PUT save with timeout + jittered-backoff retry and full
// Sentry instrumentation. Resolves on the first 2xx; on exhaustion it reports the failure
// (with connection snapshot + attempt count + elapsed time) and rethrows so the caller's
// existing catch still sets its UI error flag. A thin adapter over runSaveWithRetry: PUT
// has no response body to return, and its reconcile resolves a boolean (true = the write
// already landed), which is adapted to the core's { value } | null contract here.
export async function savePut(opts: SavePutOptions): Promise<void> {
  await runSaveWithRetry<void>({
    method: "PUT",
    url: opts.url,
    token: opts.token,
    body: opts.body,
    label: opts.label,
    profile: opts.retry ?? BACKGROUND_SAVE,
    errorPrefix: "Save failed: HTTP",
    parse: async () => undefined,
    reconcile: opts.reconcile
      ? async () => ((await opts.reconcile!()) ? { value: undefined } : null)
      : undefined,
    report: opts.report ?? reportSaveFailure,
    reportReconciled: opts.reportReconciled ?? reportSaveReconciled,
    breadcrumb: opts.breadcrumb ?? addSaveBreadcrumb,
    fetchImpl: opts.fetchImpl,
    genKey: opts.genKey,
    netInfoFetch: opts.netInfoFetch,
    sleep: opts.sleep,
    rng: opts.rng,
    now: opts.now,
  });
}
