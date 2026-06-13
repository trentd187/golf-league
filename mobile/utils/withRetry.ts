// utils/withRetry.ts
// Retry helper for idempotent network saves over flaky (cellular) links.
//
// Implements capped exponential backoff with "Full Jitter" — the variant AWS measured as
// best in "Exponential Backoff And Jitter", and the strategy the FreeRTOS/AWS-IoT
// backoffAlgorithm uses for poor-connectivity environments:
//
//     delay = random(0, min(cap, base * 2^attempt))
//
// Full Jitter spreads attempts widely in time, which (a) decorrelates our retries from the
// network's own congestion/recovery cycle and (b) varies connection timing so a stale okhttp
// keep-alive socket is evicted and the next attempt opens a fresh connection — the actual
// failure mode behind the cellular "phantom save" bug (a write commits server-side but the
// response is lost on the last-mile cellular hop, so fetch rejects and the client shows a
// false failure).
//
// Extracted from app/scorecard/[roundId].tsx (a coverage-excluded screen) so the logic is
// pure and unit-tested. `sleep` and `rng` are injectable so tests run without real timers or
// real randomness.

// BackoffOptions are the two knobs of the Full Jitter curve.
export interface BackoffOptions {
  baseMs: number; // delay unit; the ceiling for the first backoff
  capMs: number;  // maximum ceiling — bounds the exponential so delays never run away
}

// fullJitterDelay returns the milliseconds to wait before the next retry, given the
// zero-based attempt index (0 = the wait after the first failure). The ceiling grows
// exponentially (base * 2^attempt) but is clamped to capMs; the actual delay is a uniformly
// random value in [0, ceiling). `rng` is injected so tests are deterministic.
export function fullJitterDelay(
  attempt: number,
  opts: BackoffOptions,
  rng: () => number = Math.random,
): number {
  const exponential = opts.baseMs * 2 ** attempt;
  const ceiling = Math.min(opts.capMs, exponential);
  return Math.floor(rng() * ceiling);
}

// RetryOptions configure a withRetry run. maxAttempts is the total number of tries (not extra
// retries) — e.g. 5 means one initial attempt plus up to four retries.
export interface RetryOptions extends BackoffOptions {
  maxAttempts: number;
  rng?: () => number;
  sleep?: (ms: number) => Promise<void>;
  // onAttemptError fires after every failed attempt with the error, the 1-based attempt
  // number, and the delay before the next attempt (null on the final attempt, when there is
  // no next try). Used to emit per-attempt breadcrumbs without coupling this module to Sentry.
  onAttemptError?: (err: unknown, attempt: number, nextDelayMs: number | null) => void;
}

// defaultSleep waits ms milliseconds. Replaced in tests so no real time passes.
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// withRetry runs fn up to maxAttempts times, waiting fullJitterDelay(...) between attempts.
// fn receives the 1-based attempt number (handy for logging). On the final failure the last
// error is rethrown so callers can surface it.
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const { maxAttempts, baseMs, capMs } = opts;
  const rng = opts.rng ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      // Final attempt: no next delay, report and stop.
      if (attempt >= maxAttempts) {
        opts.onAttemptError?.(err, attempt, null);
        break;
      }
      // Zero-based exponent: the first backoff (after attempt 1) uses 2^0 = 1.
      const nextDelayMs = fullJitterDelay(attempt - 1, { baseMs, capMs }, rng);
      opts.onAttemptError?.(err, attempt, nextDelayMs);
      await sleep(nextDelayMs);
    }
  }
  throw lastErr;
}
