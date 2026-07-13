// utils/apiGet.ts
// The resilient READ path — the counterpart to savePut/savePost (utils/saveRequest.ts,
// utils/savePost.ts). EVERY authenticated read in the app goes through here. A bare fetch()
// is banned in app/, components/, and hooks/ by an ESLint rule, because a bare fetch has:
//
//   - no timeout: a GET stuck on a dead okhttp keep-alive socket hangs forever, and a
//     screen stuck on a spinner is indistinguishable from a frozen app;
//   - no retry: on cellular, a single dropped GET is routine, not exceptional;
//   - no telemetry: a read that never returned produced no Sentry signal at all.
//
// apiGet gives reads the same last-mile hardening the write path has had since the
// phantom-save work:
//
//   1. A bounded per-attempt timeout (AbortController) so a hung GET fails fast and the
//      next retry opens a fresh connection.
//   2. Capped exponential backoff with Full Jitter (utils/withRetry.ts) across transport
//      failures, decorrelating retries from the network's own recovery cycle.
//   3. Breadcrumbs per failed attempt and a reported failure on exhaustion (utils/sentry.ts).
//
// apiGet retries only TRANSPORT failures (a thrown/aborted fetch); any HTTP response — 2xx
// or not — is returned as-is for the caller to inspect. It does NOT retry a non-2xx: a 4xx
// won't heal on retry, and a 5xx storm shouldn't be amplified by the client. All
// collaborators are injectable so this module is fully unit-tested.
//
// Motivating bug: the scorecard phantom-save reconcile read-back was a single bare fetch()
// with no timeout or retry. On the same degraded cellular that just exhausted the write's
// retries, that one GET usually failed too — so a committed write could not be confirmed and
// the UI showed a false "failed to save" (Sentry 7/8). Reads are now hardened everywhere.

import { withRetry } from "@/utils/withRetry";
import {
  defaultNetInfoFetch,
  snapshotConnection,
  type NetInfoStateLike,
} from "@/utils/connectionSnapshot";
import { addReadBreadcrumb, reportReadFailure } from "@/utils/sentry";
import { ApiError } from "@/utils/apiError";

// ApiGetProfile bundles the retry budget with the per-attempt timeout.
export interface ApiGetProfile {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
  timeoutMs: number; // per-attempt AbortController timeout
}

// RECONCILE_GET is tuned for the reconcile read-back: it runs AFTER a write already
// exhausted its own (~30-60s) budget, so keep it modest to avoid a long tail before a
// genuine failure surfaces.
export const RECONCILE_GET: ApiGetProfile = {
  maxAttempts: 3,
  baseMs: 400,
  capMs: 4000,
  timeoutMs: 10000,
};

// READ_GET is the default for screen reads and the 60s polls. Slightly more patient than
// RECONCILE_GET (it isn't running after a failed write), but still bounded well under the
// poll interval so a stalled read can never pile up behind the next tick.
export const READ_GET: ApiGetProfile = {
  maxAttempts: 3,
  baseMs: 500,
  capMs: 5000,
  timeoutMs: 12000,
};

// ApiGetOptions configure one apiGet call. url/token are the request; the rest are injectable
// collaborators whose production defaults are applied below (so tests need no real network,
// timers, or randomness).
export interface ApiGetOptions {
  url: string;
  token: string;
  profile?: ApiGetProfile;
  // label names the endpoint in telemetry (read_endpoint). Optional so the existing
  // reconcile callers keep working untouched; every queryFn passes one.
  label?: string;
  // method/body support a READ-SHAPED POST — an endpoint that is a query in everything but
  // HTTP verb (e.g. POST /courses/search-external, which takes a search body). Routing it
  // here rather than through savePost keeps its telemetry tagged error_source:read (it
  // creates nothing) and skips the Idempotency-Key a create needs.
  method?: "GET" | "POST";
  body?: unknown;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  netInfoFetch?: () => Promise<NetInfoStateLike>;
  now?: () => number;
}

// apiGet performs an authenticated read with a per-attempt timeout and jittered-backoff retry
// over transport failures. Resolves with the Response on the first attempt that returns one
// (any status); rethrows the last error only if every attempt failed on the transport, after
// reporting it with a connection snapshot.
export async function apiGet(opts: ApiGetOptions): Promise<Response> {
  const profile = opts.profile ?? RECONCILE_GET;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const netInfoFetch = opts.netInfoFetch ?? defaultNetInfoFetch;
  const now = opts.now ?? Date.now;
  const label = opts.label ?? "unlabeled";
  const method = opts.method ?? "GET";
  const startedAt = now();
  let attempts = 0;

  try {
    return await withRetry<Response>(
      async (attempt) => {
        // withRetry hands us a 1-based attempt number, so this is the true count.
        attempts = attempt;
        // Fresh controller per attempt; abort a hung read so the next retry opens a new
        // connection. The timer is always cleared so a fast response never aborts.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), profile.timeoutMs);
        try {
          // A returned Response (even a non-2xx) resolves and is NOT retried — only a thrown
          // fetch (network error / abort) is, which is what withRetry retries on.
          return await fetchImpl(opts.url, {
            method,
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${opts.token}`,
              // Only send Content-Type when there IS a body: some proxies treat a
              // Content-Type on a bodyless GET as malformed.
              ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
          });
        } finally {
          clearTimeout(timer);
        }
      },
      {
        maxAttempts: profile.maxAttempts,
        baseMs: profile.baseMs,
        capMs: profile.capMs,
        sleep: opts.sleep,
        rng: opts.rng,
        onAttemptError: (err, attempt, nextDelayMs) => {
          addReadBreadcrumb({
            label,
            attempt, // already 1-based
            nextDelayMs,
            message: err instanceof Error ? err.message : String(err),
          });
        },
      },
    );
  } catch (err) {
    // Every attempt failed on the TRANSPORT (never got a response). Snapshot the connection
    // — lazily, only here on failure — so the log says whether we were on 3G, LTE, or an
    // unreachable radio. httpStatus stays undefined, which is what marks this "network".
    const conn = await snapshotConnection(netInfoFetch);
    reportReadFailure(err, {
      label,
      attempts,
      elapsedMs: now() - startedAt,
      ...conn,
    });
    // Rethrow as a REPORTED ApiError with no status: no status is what marks a transport
    // failure, and `reported` stops the QueryCache handler from filing a duplicate Sentry
    // event for something we just described far more precisely.
    throw new ApiError(err instanceof Error ? err.message : String(err), {
      reported: true,
      label,
    });
  }
}

// ApiGetJsonOptions is ApiGetOptions with a required label — telemetry on a screen read is
// worthless if you can't tell which endpoint failed.
export interface ApiGetJsonOptions extends Omit<ApiGetOptions, "label"> {
  label: string;
}

// apiGetJson is the one-liner every queryFn uses: a hardened read that returns parsed JSON
// or throws a descriptive Error. It reports a non-2xx (which apiGet deliberately does not,
// since apiGet's callers may want to inspect the status themselves) so an HTTP failure is
// as visible as a transport failure.
//
// The thrown Error carries the API's own { error } message when there is one, so a screen's
// error state shows something meaningful instead of "HTTP 500".
export async function apiGetJson<T>(opts: ApiGetJsonOptions): Promise<T> {
  const now = opts.now ?? Date.now;
  const netInfoFetch = opts.netInfoFetch ?? defaultNetInfoFetch;
  const startedAt = now();

  // Transport exhaustion is already reported inside apiGet — let it propagate.
  const res = await apiGet({ ...opts, profile: opts.profile ?? READ_GET });

  if (!res.ok) {
    const apiMessage = await readApiErrorMessage(res);
    const err = new ApiError(apiMessage ?? `Request failed: HTTP ${res.status}`, {
      status: res.status,
      reported: true,
      label: opts.label,
    });
    const conn = await snapshotConnection(netInfoFetch);
    reportReadFailure(err, {
      label: opts.label,
      attempts: 1, // a non-2xx is never retried, so the response came on the attempt that returned it
      elapsedMs: now() - startedAt,
      httpStatus: res.status,
      ...conn,
    });
    throw err;
  }

  return (await res.json()) as T;
}

// readApiErrorMessage pulls the API's { error: "..." } message out of a failed response.
// Returns undefined when the body isn't JSON or carries no message, so callers fall back to
// a status-based string. Never throws — a broken error body must not mask the real error.
//
// Duplicated in spirit by saveRequest.ts's identically-named helper, which serves the write
// path; kept separate so the read path has no import edge into the save modules.
async function readApiErrorMessage(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body?.error === "string" && body.error ? body.error : undefined;
  } catch {
    return undefined;
  }
}
