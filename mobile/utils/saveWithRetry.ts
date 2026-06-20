// utils/saveWithRetry.ts
// The shared instrumented core behind savePut (utils/saveRequest.ts, idempotent PUT
// saves) and savePost (utils/savePost.ts, non-idempotent POST creates). One place owns
// the cellular hardening every write needs:
//
//   1. A bounded per-attempt timeout (AbortController) so a request stuck on a dead
//      okhttp keep-alive socket fails fast and the next retry opens a fresh connection.
//   2. Capped exponential backoff with Full Jitter (utils/withRetry.ts).
//   3. A stable Idempotency-Key reused across every retry (utils/idempotency.ts) so the
//      backend can dedupe a replayed write (middleware/idempotency.go).
//   4. A lazy connection snapshot + Sentry telemetry on exhaustion, and an optional
//      read-back reconcile that suppresses a false failure when the write already landed.
//
// PUT and POST differ only in the HTTP method, whether a response body is returned
// (parse), the error-message prefix, and which concrete Sentry reporters they use — all
// injected by the thin savePut/savePost adapters. Every collaborator is injectable so
// this module is fully unit-tested (indirectly, via the two adapters' suites) while the
// calling screens stay coverage-excluded. See mobile/docs/network-saves.md and the
// project memory project-cellular-phantom-saves.

import { withRetry, type RetryOptions } from "@/utils/withRetry";
import { newIdempotencyKey } from "@/utils/idempotency";
import {
  snapshotConnection,
  defaultNetInfoFetch,
  type NetInfoStateLike,
} from "@/utils/connectionSnapshot";
import { type SaveBreadcrumbContext } from "@/utils/sentry";

// RetryProfile bundles the backoff knobs with the per-attempt timeout. Presets live in
// the adapters (BACKGROUND_SAVE / FOREGROUND_SAVE in saveRequest.ts, CREATE_SAVE in
// savePost.ts); see mobile/docs/network-saves.md for the AWS/FreeRTOS citations.
export interface RetryProfile {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
  timeoutMs: number; // per-attempt AbortController timeout
}

// SaveFailureReport is the diagnostic context passed to the failure reporter on
// exhaustion. SaveFailureContext and CreateFailureContext are both structurally this
// shape, so a single core context satisfies either adapter's reporter.
export interface SaveFailureReport {
  label: string;
  attempts: number;
  elapsedMs: number;
  httpStatus?: number; // set only when the final failure was an HTTP non-2xx
  connectionType?: string;
  cellularGeneration?: string | null;
  isInternetReachable?: boolean | null;
}

// SaveReconciledReport is the context for a recovered phantom write (the ack was lost
// but a read-back confirmed the write landed).
export interface SaveReconciledReport {
  label: string;
  attempts: number;
  elapsedMs: number;
  connectionType?: string;
  cellularGeneration?: string | null;
}

// RunSaveOptions configure one runSaveWithRetry call. The first block is the request and
// behaviour; report/reportReconciled/breadcrumb are the concrete (injected) telemetry;
// the rest are injectable collaborators whose production defaults are applied below.
export interface RunSaveOptions<T> {
  method: "PUT" | "POST";
  url: string;
  token: string;
  body: unknown;
  label: string;
  profile: RetryProfile;
  errorPrefix: string; // "Save failed: HTTP" | "Create failed: HTTP"
  // parse turns a successful Response into the resolved value: PUT passes a no-op
  // (resolves undefined); POST parses the JSON body for the new row's id.
  parse: (res: Response) => Promise<T>;
  // parseErrorMessage, when provided, extracts a human message from a non-2xx response
  // (e.g. the API's { error } body) so the surfaced error reads usefully instead of a
  // generic "HTTP 400". Creates pass it (they show the message to the user); background
  // PUT saves omit it. Returning undefined (or throwing) falls back to errorPrefix.
  parseErrorMessage?: (res: Response) => Promise<string | undefined>;
  // reconcile, when provided, runs only after every retry fails with a TRANSPORT error
  // (not an HTTP non-2xx). It should read authoritative server state and resolve
  // { value } when the write already committed (a phantom — ack lost, data safe), or
  // null when it did not. A throw or null falls through to the normal failure path; its
  // own failure must never mask the original error.
  reconcile?: () => Promise<{ value: T } | null>;
  // Telemetry (the adapter injects PUT- or create-flavoured reporters):
  report: (error: unknown, ctx: SaveFailureReport) => void;
  reportReconciled: (ctx: SaveReconciledReport) => void;
  breadcrumb: (ctx: SaveBreadcrumbContext) => void;
  // Injectables (production defaults applied below):
  fetchImpl?: typeof fetch;
  genKey?: () => string;
  netInfoFetch?: () => Promise<NetInfoStateLike>;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  now?: () => number;
}

// runSaveWithRetry performs one write with timeout + jittered-backoff retry, a stable
// Idempotency-Key, and full Sentry instrumentation. Resolves with parse(res) on the
// first 2xx. On exhaustion it reconciles a transport failure if asked (suppressing a
// confirmed phantom), otherwise reports the failure and rethrows so the caller's catch
// still runs.
export async function runSaveWithRetry<T>(opts: RunSaveOptions<T>): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const netInfoFetch = opts.netInfoFetch ?? defaultNetInfoFetch;
  const now = opts.now ?? Date.now;

  // One Idempotency-Key per logical write, minted up front and reused on every retry so
  // a phantom write (commit + lost ack) is resent with the same key the backend dedupes.
  const idempotencyKey = (opts.genKey ?? newIdempotencyKey)();

  const startedAt = now();
  let attempts = 0;
  // The final attempt's HTTP status (undefined when it was a transport reject / abort).
  // Reset each attempt so it reflects the LAST failure, matching the error withRetry rethrows.
  let httpStatus: number | undefined;

  const retryOpts: RetryOptions = {
    maxAttempts: opts.profile.maxAttempts,
    baseMs: opts.profile.baseMs,
    capMs: opts.profile.capMs,
    sleep: opts.sleep,
    rng: opts.rng,
    onAttemptError: (err, attempt, nextDelayMs) => {
      opts.breadcrumb({
        label: opts.label,
        attempt,
        nextDelayMs,
        message: err instanceof Error ? err.message : String(err),
      });
    },
  };

  try {
    return await withRetry<T>(async () => {
      attempts += 1;
      httpStatus = undefined;
      // Fresh controller per attempt; abort a hung request so the next retry opens a new
      // connection. The timer is always cleared so a fast response never aborts.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.profile.timeoutMs);
      try {
        const res = await fetchImpl(opts.url, {
          method: opts.method,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${opts.token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(opts.body),
        });
        if (!res.ok) {
          httpStatus = res.status;
          const msg = opts.parseErrorMessage ? await opts.parseErrorMessage(res) : undefined;
          throw new Error(msg ?? `${opts.errorPrefix} ${res.status}`);
        }
        return await opts.parse(res);
      } finally {
        clearTimeout(timer);
      }
    }, retryOpts);
  } catch (err) {
    const conn = await snapshotConnection(netInfoFetch);

    // Phantom-write recovery: an idempotent write (or a deduped create) can commit
    // server-side while the last-mile cellular hop drops the ack, exhausting every
    // retry. Only a lost RESPONSE is recoverable, so reconcile only transport failures
    // (no httpStatus) — a real HTTP non-2xx means the server rejected the write and must
    // surface. A reconcile that throws or returns null falls through to the failure path.
    if (opts.reconcile && httpStatus === undefined) {
      try {
        const recovered = await opts.reconcile();
        if (recovered !== null) {
          opts.reportReconciled({
            label: opts.label,
            attempts,
            elapsedMs: now() - startedAt,
            connectionType: conn.connectionType,
            cellularGeneration: conn.cellularGeneration,
          });
          return recovered.value;
        }
      } catch {
        // Reconciliation is best-effort; fall through to the real failure path.
      }
    }

    opts.report(err, {
      label: opts.label,
      attempts,
      elapsedMs: now() - startedAt,
      httpStatus,
      ...conn,
    });
    throw err;
  }
}
