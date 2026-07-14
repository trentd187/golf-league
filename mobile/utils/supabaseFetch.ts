// utils/supabaseFetch.ts
// The hardened fetch that @supabase/supabase-js uses for EVERY auth and storage call.
// Injected once via createClient(..., { global: { fetch } }) in utils/supabase.ts.
//
// Why this exists — the hole under the hardened layer. apiGet/savePut/savePost bound and
// instrument every call to OUR backend, but every one of them begins:
//
//     const token = await getToken();          // → supabase.auth.getSession()
//     await apiGetJson({ url, token, ... });   // ← AbortController starts HERE
//
// getSession() is only local while the access token is still valid; once it expires it makes
// a network round-trip to POST /auth/v1/token?grant_type=refresh_token. Supabase's client
// used the platform's bare fetch, so that refresh had no timeout, no retry, and no telemetry
// — an unbounded call running IN FRONT OF every hardened call. On a dead cellular socket it
// hangs before apiGet's timeout ever exists, which is why hardening the backend calls alone
// never fully fixed the "the app just froze" reports. Same for the avatar upload to Storage
// and for every sign-in call.
//
// What it adds: a per-attempt AbortController timeout, Full-Jitter backoff (utils/withRetry.ts)
// on TRANSPORT failures only, and Sentry breadcrumbs + a reported failure on exhaustion.
//
// What it deliberately does NOT do: blind-retry a non-idempotent request. Retrying
// POST /auth/v1/otp would send a second magic-link email; retrying /verify would burn a
// one-time code. Only GET/HEAD and the token refresh (which is safe to repeat — it returns
// the same session) are retried. This is the project's standing idempotent-retry rule,
// applied to the one surface it never covered.

import { withRetry } from "@/utils/withRetry";
import {
  defaultNetInfoFetch,
  snapshotConnection,
  type NetInfoStateLike,
} from "@/utils/connectionSnapshot";
import {
  addSupabaseBreadcrumb,
  reportSupabaseFailure,
  type SupabaseFailureContext,
} from "@/utils/sentry";

// SupabaseRequestPlan is the decision made about one outbound Supabase request, derived
// purely from its URL and method. Split out so the policy (what may be retried, how long we
// wait, what it's called in Sentry) is a pure function with its own tests.
export interface SupabaseRequestPlan {
  label: string; // stable, PII-free endpoint label → supabase_endpoint in Sentry
  kind: "auth" | "storage" | "other";
  retryable: boolean;
  maxAttempts: number;
  timeoutMs: number;
}

// Auth calls are small and interactive — a user is watching a spinner, so fail fast.
const AUTH_TIMEOUT_MS = 15000;
// Storage moves a resized avatar (≤512px JPEG, tens of KB) but on a weak uplink that still
// takes a while, and a half-uploaded photo is worse than a slow one.
const STORAGE_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 3;

// classifySupabaseRequest decides how one request is treated. Labels are coarse on purpose:
// a storage object path contains a user id and filename, and an auth URL can carry a token in
// its query — neither belongs in a Sentry tag.
export function classifySupabaseRequest(url: string, method: string): SupabaseRequestPlan {
  const verb = method.toUpperCase();
  // GET/HEAD are safe to repeat by definition.
  const isReadVerb = verb === "GET" || verb === "HEAD";

  if (url.includes("/auth/v1/")) {
    // The token refresh is a POST but IS idempotent: replaying it returns the same session
    // rather than creating anything. It is also the single most important call to retry —
    // when it fails, every subsequent API call goes out with an empty Bearer and 401s.
    const isRefresh = url.includes("grant_type=refresh_token");
    const retryable = isReadVerb || isRefresh;
    return {
      label: authLabel(url, isRefresh),
      kind: "auth",
      retryable,
      maxAttempts: retryable ? MAX_ATTEMPTS : 1,
      timeoutMs: AUTH_TIMEOUT_MS,
    };
  }

  if (url.includes("/storage/v1/")) {
    return {
      label: isReadVerb ? "storage.download" : "storage.upload",
      kind: "storage",
      retryable: isReadVerb,
      maxAttempts: isReadVerb ? MAX_ATTEMPTS : 1,
      timeoutMs: STORAGE_TIMEOUT_MS,
    };
  }

  return {
    label: "supabase.other",
    kind: "other",
    retryable: isReadVerb,
    maxAttempts: isReadVerb ? MAX_ATTEMPTS : 1,
    timeoutMs: AUTH_TIMEOUT_MS,
  };
}

// authLabel names the auth endpoint without leaking the query string (which can carry a
// token or a one-time code).
function authLabel(url: string, isRefresh: boolean): string {
  if (isRefresh) return "auth.token_refresh";
  if (url.includes("/auth/v1/token")) return "auth.token";
  if (url.includes("/auth/v1/otp")) return "auth.otp";
  if (url.includes("/auth/v1/verify")) return "auth.verify";
  if (url.includes("/auth/v1/logout")) return "auth.logout";
  if (url.includes("/auth/v1/user")) return "auth.user";
  return "auth.other";
}

// SupabaseFetchDeps are the injectable collaborators. Production defaults are applied in
// createSupabaseFetch, so tests run with no real network, timers, or randomness.
export interface SupabaseFetchDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  netInfoFetch?: () => Promise<NetInfoStateLike>;
  now?: () => number;
  report?: (error: unknown, ctx: SupabaseFailureContext) => void;
  breadcrumb?: typeof addSupabaseBreadcrumb;
}

// createSupabaseFetch returns a fetch-shaped function to hand to createClient. It preserves
// fetch's contract exactly — a Response for any status, a throw only on a transport failure —
// so supabase-js's own error handling is unchanged.
export function createSupabaseFetch(deps: SupabaseFetchDeps = {}): typeof fetch {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const netInfoFetch = deps.netInfoFetch ?? defaultNetInfoFetch;
  const now = deps.now ?? Date.now;
  const report = deps.report ?? reportSupabaseFailure;
  const breadcrumb = deps.breadcrumb ?? addSupabaseBreadcrumb;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const method = init?.method ?? requestMethod(input);
    const plan = classifySupabaseRequest(url, method);
    const startedAt = now();
    let attempts = 0;

    try {
      const res = await withRetry<Response>(
        async (attempt) => {
          attempts = attempt; // withRetry's attempt is already 1-based
          return await fetchWithTimeout(fetchImpl, input, init, plan.timeoutMs);
        },
        {
          maxAttempts: plan.maxAttempts,
          baseMs: 400,
          capMs: 4000,
          sleep: deps.sleep,
          rng: deps.rng,
          onAttemptError: (err, attempt, nextDelayMs) => {
            breadcrumb({
              label: plan.label,
              attempt,
              nextDelayMs,
              message: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      // A 4xx is normal (bad OTP, expired refresh token) and is handled by the caller via
      // supabase-js's { error } — reporting it would be noise. A 5xx is Supabase itself
      // failing, which we want to see.
      if (res.status >= 500) {
        const conn = await snapshotConnection(netInfoFetch);
        report(new Error(`Supabase ${plan.label} failed: HTTP ${res.status}`), {
          label: plan.label,
          kind: plan.kind,
          attempts,
          elapsedMs: now() - startedAt,
          httpStatus: res.status,
          ...conn,
        });
      }
      return res;
    } catch (err) {
      // Every attempt died on the transport. Snapshot the radio lazily — only here, on
      // failure — so the report says whether we were on LTE or an unreachable cell.
      const conn = await snapshotConnection(netInfoFetch);
      report(err, {
        label: plan.label,
        kind: plan.kind,
        attempts,
        elapsedMs: now() - startedAt,
        ...conn,
      });
      // Rethrow the ORIGINAL error, unwrapped: supabase-js inspects it to build its own
      // AuthRetryableFetchError / StorageUnknownError, and wrapping it would break the
      // { data, error } contract every caller relies on.
      throw err;
    }
  };
}

// fetchWithTimeout runs one attempt under a fresh AbortController so a hung request fails
// fast and the retry opens a new connection. A caller-supplied signal (supabase-js passes one
// for some calls) is chained in, so an upstream cancel still cancels us.
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const callerSignal = init?.signal;
  const onCallerAbort = (): void => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onCallerAbort);
  }

  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

// requestUrl/requestMethod normalize fetch's three input shapes (string | URL | Request) so
// the classifier sees a plain string and a plain verb.
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(input: RequestInfo | URL): string {
  if (typeof input === "string" || input instanceof URL) return "GET";
  return input.method || "GET";
}
