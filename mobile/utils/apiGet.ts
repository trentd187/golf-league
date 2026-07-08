// utils/apiGet.ts
// The resilient GET counterpart to savePut/savePost (utils/saveRequest.ts, utils/savePost.ts).
// Every authenticated read that MUST succeed on a flaky (cellular) link should go through
// apiGet instead of a bare fetch(), so it gets the same last-mile hardening the write path
// has:
//
//   1. A bounded per-attempt timeout (AbortController) so a GET stuck on a dead okhttp
//      keep-alive socket fails fast and the next retry opens a fresh connection — a bare
//      fetch() has no timeout and can hang indefinitely.
//   2. Capped exponential backoff with Full Jitter (utils/withRetry.ts) across transport
//      failures, decorrelating retries from the network's own recovery cycle.
//
// Motivating bug: the scorecard phantom-save reconcile read-back was a single bare fetch()
// with no timeout or retry. On the same degraded cellular that just exhausted the write's
// retries, that one GET usually failed too — so a committed write could not be confirmed and
// the UI showed a false "failed to save" (Sentry 7/8: 11 read-backs succeeded, but the one
// that also lost the GET surfaced the false error). Giving the read-back its own retry budget
// closes that gap.
//
// apiGet retries only TRANSPORT failures (a thrown/aborted fetch); any HTTP response — 2xx or
// not — is returned as-is for the caller to inspect (res.ok, res.status). It does NOT retry a
// non-2xx: a 4xx won't heal on retry, and the reconcile callers already treat !res.ok as "not
// confirmed". All collaborators are injectable so this module is fully unit-tested.

import { withRetry } from "@/utils/withRetry";

// ApiGetProfile bundles the retry budget with the per-attempt timeout. The default is tuned
// for the reconcile read-back: it runs AFTER a write already exhausted its own (~30-60s)
// budget, so keep this modest to avoid a long tail before a genuine failure surfaces.
export interface ApiGetProfile {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
  timeoutMs: number; // per-attempt AbortController timeout
}

export const RECONCILE_GET: ApiGetProfile = {
  maxAttempts: 3,
  baseMs: 400,
  capMs: 4000,
  timeoutMs: 10000,
};

// ApiGetOptions configure one apiGet call. url/token are the request; the rest are injectable
// collaborators whose production defaults are applied below (so tests need no real network,
// timers, or randomness).
export interface ApiGetOptions {
  url: string;
  token: string;
  profile?: ApiGetProfile;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
}

// apiGet performs an authenticated GET with a per-attempt timeout and jittered-backoff retry
// over transport failures. Resolves with the Response on the first attempt that returns one
// (any status); rethrows the last error only if every attempt failed on the transport.
export async function apiGet(opts: ApiGetOptions): Promise<Response> {
  const profile = opts.profile ?? RECONCILE_GET;
  const fetchImpl = opts.fetchImpl ?? fetch;

  return withRetry<Response>(
    async () => {
      // Fresh controller per attempt; abort a hung GET so the next retry opens a new
      // connection. The timer is always cleared so a fast response never aborts.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), profile.timeoutMs);
      try {
        // A returned Response (even a non-2xx) resolves and is NOT retried — only a thrown
        // fetch (network error / abort) is, which is what withRetry retries on.
        return await fetchImpl(opts.url, {
          method: "GET",
          signal: controller.signal,
          headers: { Authorization: `Bearer ${opts.token}` },
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
    },
  );
}
