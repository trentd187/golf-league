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

import NetInfo from "@react-native-community/netinfo";
import { withRetry, type RetryOptions } from "@/utils/withRetry";
import {
  reportSaveFailure,
  addSaveBreadcrumb,
  type SaveFailureContext,
} from "@/utils/sentry";

// RetryProfile bundles the backoff knobs with the per-attempt timeout. Two presets
// below; see mobile/docs/network-saves.md for the AWS/FreeRTOS citations behind them.
export interface RetryProfile {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
  timeoutMs: number; // per-attempt AbortController timeout
}

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

// ConnectionSnapshot is the subset of a NetInfo state we attach to a failure report.
interface ConnectionSnapshot {
  connectionType: string;
  cellularGeneration: string | null;
  isInternetReachable: boolean | null;
}

// The shape of the bits of a NetInfo state we read. Loose on purpose — NetInfo's
// details union varies by connection type, and we only want a few optional fields.
interface NetInfoStateLike {
  type?: string;
  isInternetReachable?: boolean | null;
  details?: { cellularGeneration?: string | null } | null;
}

// defaultNetInfoFetch adapts the real NetInfo.fetch() to NetInfoStateLike. NetInfo's
// full NetInfoState is a discriminated union whose per-type details (wifi/cellular/…)
// don't structurally match our loose shape, so we narrow to just the fields we report.
// Declaring the return type here keeps the savePut default's type identical to the
// injectable's, avoiding a union that wouldn't be assignable to snapshotConnection.
function defaultNetInfoFetch(): Promise<NetInfoStateLike> {
  return NetInfo.fetch().then((s) => ({
    type: s.type,
    isInternetReachable: s.isInternetReachable,
    details:
      s.details && "cellularGeneration" in s.details
        ? { cellularGeneration: (s.details.cellularGeneration as string | null) ?? null }
        : null,
  }));
}

// snapshotConnection reads the current connection type lazily (only on failure, so
// the happy path pays nothing) and never throws — a NetInfo error degrades to
// "unknown" so it can't mask the original save failure.
async function snapshotConnection(
  netInfoFetch: () => Promise<NetInfoStateLike>,
): Promise<ConnectionSnapshot> {
  try {
    const state = await netInfoFetch();
    return {
      connectionType: state?.type ?? "unknown",
      cellularGeneration: state?.details?.cellularGeneration ?? null,
      isInternetReachable: state?.isInternetReachable ?? null,
    };
  } catch {
    return {
      connectionType: "unknown",
      cellularGeneration: null,
      isInternetReachable: null,
    };
  }
}

// SavePutOptions configure one savePut call. url/token/body/label are the request;
// retry picks a profile; the rest are injectable collaborators (defaults wire the
// real implementations) so tests run without a network, NetInfo, Sentry, or timers.
export interface SavePutOptions {
  url: string;
  token: string;
  body: unknown;
  label: string; // "scores" | "hole-stats" | "handicap"
  retry?: RetryProfile;
  // Injectables (production defaults applied below):
  fetchImpl?: typeof fetch;
  netInfoFetch?: () => Promise<NetInfoStateLike>;
  report?: (error: unknown, ctx: SaveFailureContext) => void;
  breadcrumb?: typeof addSaveBreadcrumb;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  now?: () => number;
}

// savePut performs an idempotent PUT save with timeout + jittered-backoff retry and
// full Sentry instrumentation. Resolves on the first 2xx; on exhaustion it reports the
// failure (with connection snapshot + attempt count + elapsed time) and rethrows so the
// caller's existing catch still sets its UI error flag.
export async function savePut(opts: SavePutOptions): Promise<void> {
  const profile = opts.retry ?? BACKGROUND_SAVE;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const netInfoFetch = opts.netInfoFetch ?? defaultNetInfoFetch;
  const report = opts.report ?? reportSaveFailure;
  const breadcrumb = opts.breadcrumb ?? addSaveBreadcrumb;
  const now = opts.now ?? Date.now;

  const startedAt = now();
  let attempts = 0;
  // Tracks the final attempt's HTTP status (undefined when it was a transport reject /
  // abort). Reset each attempt so it reflects the *last* failure, matching the error
  // withRetry rethrows.
  let httpStatus: number | undefined;

  const retryOpts: RetryOptions = {
    maxAttempts: profile.maxAttempts,
    baseMs: profile.baseMs,
    capMs: profile.capMs,
    sleep: opts.sleep,
    rng: opts.rng,
    onAttemptError: (err, attempt, nextDelayMs) => {
      breadcrumb({
        label: opts.label,
        attempt,
        nextDelayMs,
        message: err instanceof Error ? err.message : String(err),
      });
    },
  };

  try {
    await withRetry(async () => {
      attempts += 1;
      httpStatus = undefined;
      // Fresh controller per attempt; abort a hung request so the next retry opens a
      // new connection. The timer is always cleared so a fast response never aborts.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), profile.timeoutMs);
      try {
        const res = await fetchImpl(opts.url, {
          method: "PUT",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${opts.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(opts.body),
        });
        if (!res.ok) {
          httpStatus = res.status;
          throw new Error(`Save failed: HTTP ${res.status}`);
        }
      } finally {
        clearTimeout(timer);
      }
    }, retryOpts);
  } catch (err) {
    const conn = await snapshotConnection(netInfoFetch);
    report(err, {
      label: opts.label,
      attempts,
      elapsedMs: now() - startedAt,
      httpStatus,
      ...conn,
    });
    throw err;
  }
}
