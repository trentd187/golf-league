// __tests__/utils/withRetry.test.ts
// Unit tests for the Full Jitter backoff + retry helper in utils/withRetry.ts.
// rng and sleep are injected so the tests are deterministic and run without real timers.

import { fullJitterDelay, withRetry } from "@/utils/withRetry";

describe("fullJitterDelay", () => {
  it("returns 0 when rng returns 0 (the bottom of the jitter window)", () => {
    expect(fullJitterDelay(3, { baseMs: 500, capMs: 8000 }, () => 0)).toBe(0);
  });

  it("uses the exponential ceiling when it is below the cap", () => {
    // attempt 2 → ceiling = min(8000, 500 * 2^2 = 2000) = 2000; rng 0.5 → 1000.
    expect(fullJitterDelay(2, { baseMs: 500, capMs: 8000 }, () => 0.5)).toBe(1000);
  });

  it("grows exponentially with the attempt index", () => {
    const rng = () => 0.999999;
    const d0 = fullJitterDelay(0, { baseMs: 500, capMs: 8000 }, rng);
    const d1 = fullJitterDelay(1, { baseMs: 500, capMs: 8000 }, rng);
    const d2 = fullJitterDelay(2, { baseMs: 500, capMs: 8000 }, rng);
    expect(d0).toBeLessThan(500);
    expect(d1).toBeGreaterThan(d0); // ~1000
    expect(d2).toBeGreaterThan(d1); // ~2000
  });

  it("never exceeds the cap once the exponential ceiling passes it", () => {
    // attempt 10 → base * 2^10 = 512000, far above the 8000 cap.
    const d = fullJitterDelay(10, { baseMs: 500, capMs: 8000 }, () => 0.999999);
    expect(d).toBeLessThan(8000);
    expect(d).toBeGreaterThanOrEqual(7990);
  });
});

describe("withRetry", () => {
  // Injected sleep that resolves immediately so no real time passes; its call count tells us
  // how many backoffs occurred. rng=0 makes every computed delay deterministically 0.
  const noSleep = jest.fn().mockResolvedValue(undefined);
  const rng = () => 0;
  const base = { maxAttempts: 5, baseMs: 500, capMs: 8000, sleep: noSleep, rng };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the result on the first successful attempt without sleeping", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    await expect(withRetry(fn, base)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("retries on rejection and succeeds on a later attempt", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("net 1"))
      .mockRejectedValueOnce(new Error("net 2"))
      .mockResolvedValue("ok");
    await expect(withRetry(fn, base)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledTimes(2); // two backoffs before the success
  });

  it("passes the 1-based attempt number to fn", async () => {
    const seen: number[] = [];
    const fn = jest.fn(async (attempt: number) => {
      seen.push(attempt);
      if (attempt < 3) throw new Error("retry");
      return "ok";
    });
    await withRetry(fn, base);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("throws the last error after exhausting maxAttempts and never sleeps after the final try", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("always fails"));
    await expect(
      withRetry(fn, { ...base, maxAttempts: 3 }),
    ).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledTimes(2); // no sleep after attempt 3
  });

  it("calls onAttemptError after each failure with attempt# and the next delay (null on the last)", async () => {
    const onAttemptError = jest.fn();
    const fn = jest.fn().mockRejectedValue(new Error("boom"));
    await expect(
      withRetry(fn, { ...base, maxAttempts: 3, onAttemptError }),
    ).rejects.toThrow("boom");
    expect(onAttemptError).toHaveBeenCalledTimes(3);
    // rng=0 makes every computed delay 0; the final attempt has no next delay → null.
    expect(onAttemptError).toHaveBeenNthCalledWith(1, expect.any(Error), 1, 0);
    expect(onAttemptError).toHaveBeenNthCalledWith(2, expect.any(Error), 2, 0);
    expect(onAttemptError).toHaveBeenNthCalledWith(3, expect.any(Error), 3, null);
  });
});
