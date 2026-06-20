// utils/savePost.ts
// The instrumented chokepoint for non-idempotent POST creates (event, round, group,
// member, guest, team) — the POST counterpart to savePut (utils/saveRequest.ts). A thin
// adapter over the shared core (utils/saveWithRetry.ts), so every create gets the same
// cellular hardening the idempotent saves already have: a bounded per-attempt timeout,
// Full-Jitter backoff, a stable Idempotency-Key, a connection snapshot, and Sentry
// telemetry.
//
// Why retrying a non-idempotent POST is now safe: the client sends one stable
// Idempotency-Key per logical create (reused across retries), and the backend durable
// idempotency store (backend/internal/middleware/idempotency.go) REPLAYS the original
// response on a repeat instead of creating a second row. So a cellular phantom create
// (row committed, ack lost) is retried without duplicating — and the first surviving ack
// returns the new row's id, which is why savePost resolves the parsed body (unlike
// savePut, which resolves void): creates need the id to navigate.
//
// All collaborators are injectable so this module is fully unit-tested while the calling
// screens stay coverage-excluded (the extract-first rule). See mobile/docs/network-saves.md.

import { runSaveWithRetry, type RetryProfile } from "@/utils/saveWithRetry";
import { type NetInfoStateLike } from "@/utils/connectionSnapshot";
import {
  reportCreateFailure,
  reportCreateReconciled,
  addCreateBreadcrumb,
  type CreateFailureContext,
  type CreateReconciledContext,
} from "@/utils/sentry";

// CREATE_SAVE — creates are foreground actions (a spinner + disabled button), so a short
// budget rides out a brief cellular drop without a long spinner; the user can re-tap.
// Retrying is safe because the backend dedupes on the Idempotency-Key.
export const CREATE_SAVE: RetryProfile = {
  maxAttempts: 3,
  baseMs: 500,
  capMs: 4000,
  timeoutMs: 12000,
};

// SavePostOptions configure one savePost<T> call, where T is the parsed response body
// (the created row). url/token/body/label are the request; retry picks a profile; the
// rest are injectable collaborators whose defaults wire the real implementations.
export interface SavePostOptions<T> {
  url: string;
  token: string;
  body: unknown;
  label: string; // create endpoint: "event" | "round" | "group" | "guest" | "team" | …
  retry?: RetryProfile;
  // reconcile, when provided, runs only after every retry fails with a TRANSPORT error.
  // It should read authoritative server state and resolve the created row when it already
  // exists (a phantom create — row committed, ack lost) or null when it does not. Most
  // callers omit it: the backend response replay already recovers the id on any surviving
  // ack, so reconcile is a last-resort fallback for when every attempt's ack is lost.
  reconcile?: () => Promise<T | null>;
  // Injectables (production defaults applied below):
  fetchImpl?: typeof fetch;
  genKey?: () => string; // mints the Idempotency-Key; default is a v4 UUID
  netInfoFetch?: () => Promise<NetInfoStateLike>;
  report?: (error: unknown, ctx: CreateFailureContext) => void;
  reportReconciled?: (ctx: CreateReconciledContext) => void;
  breadcrumb?: typeof addCreateBreadcrumb;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  now?: () => number;
}

// savePost performs a non-idempotent POST create with timeout + jittered-backoff retry,
// a stable Idempotency-Key (so the backend dedupes the retry), and full Sentry
// instrumentation. Resolves with the parsed JSON body on the first 2xx; on exhaustion it
// reconciles a transport failure if asked, else reports the failure and rethrows so the
// caller's existing catch still surfaces the error.
export async function savePost<T = unknown>(opts: SavePostOptions<T>): Promise<T> {
  return runSaveWithRetry<T>({
    method: "POST",
    url: opts.url,
    token: opts.token,
    body: opts.body,
    label: opts.label,
    profile: opts.retry ?? CREATE_SAVE,
    errorPrefix: "Create failed: HTTP",
    parse: (res) => res.json() as Promise<T>,
    // Surface the API's { error } message on a non-2xx so the user sees the real reason
    // (e.g. "scheduled_date required") instead of a bare status code.
    parseErrorMessage: async (res) => {
      try {
        const body = (await res.json()) as { error?: string };
        return body.error;
      } catch {
        return undefined;
      }
    },
    // Adapt the T | null create reconcile to the core's { value } | null contract.
    reconcile: opts.reconcile
      ? async () => {
          const recovered = await opts.reconcile!();
          return recovered === null || recovered === undefined ? null : { value: recovered };
        }
      : undefined,
    report: opts.report ?? reportCreateFailure,
    reportReconciled: opts.reportReconciled ?? reportCreateReconciled,
    breadcrumb: opts.breadcrumb ?? addCreateBreadcrumb,
    fetchImpl: opts.fetchImpl,
    genKey: opts.genKey,
    netInfoFetch: opts.netInfoFetch,
    sleep: opts.sleep,
    rng: opts.rng,
    now: opts.now,
  });
}
