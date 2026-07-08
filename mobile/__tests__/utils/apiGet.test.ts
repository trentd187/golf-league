// __tests__/utils/apiGet.test.ts
// Unit tests for the resilient GET helper in utils/apiGet.ts — the read counterpart to
// savePut/savePost. fetch, sleep, and rng are injected so the tests run deterministically
// with no real network, timers, or randomness. The key behaviors: a per-attempt timeout +
// jittered-backoff retry over TRANSPORT failures, but NO retry of a returned non-2xx.

import { apiGet, RECONCILE_GET } from "@/utils/apiGet";

const noSleep = jest.fn().mockResolvedValue(undefined);
const rng = () => 0; // every Full-Jitter delay collapses to 0

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    url: "http://localhost:8080/api/v1/rounds/r1/scorecard",
    token: "jwt-123",
    sleep: noSleep,
    rng,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  noSleep.mockResolvedValue(undefined);
});

describe("apiGet — happy path", () => {
  it("issues one GET with bearer auth and resolves the Response", async () => {
    const res = { ok: true, status: 200 };
    const fetchImpl = jest.fn().mockResolvedValue(res);

    await expect(apiGet(baseOpts({ fetchImpl }))).resolves.toBe(res);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://localhost:8080/api/v1/rounds/r1/scorecard");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer jwt-123");
    // A per-attempt AbortController wires a signal so a hung GET can be aborted.
    expect(init.signal).toBeDefined();
  });
});

describe("apiGet — non-2xx is returned, not retried", () => {
  it("returns a 404 Response after a single attempt (a 4xx won't heal on retry)", async () => {
    const res = { ok: false, status: 404 };
    const fetchImpl = jest.fn().mockResolvedValue(res);

    await expect(apiGet(baseOpts({ fetchImpl }))).resolves.toBe(res);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });
});

describe("apiGet — transport retry (the phantom-read-back fix)", () => {
  it("retries a thrown transport error and resolves once a later attempt returns", async () => {
    const res = { ok: true, status: 200 };
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValue(res);

    await expect(apiGet(baseOpts({ fetchImpl }))).resolves.toBe(res);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledTimes(2); // a backoff between each of the 3 attempts
  });

  it("rethrows after exhausting maxAttempts when every attempt fails on the transport", async () => {
    const err = new TypeError("Network request failed");
    const fetchImpl = jest.fn().mockRejectedValue(err);

    await expect(apiGet(baseOpts({ fetchImpl }))).rejects.toBe(err);
    expect(fetchImpl).toHaveBeenCalledTimes(RECONCILE_GET.maxAttempts);
  });
});

describe("apiGet — custom profile", () => {
  it("honors a caller-supplied attempt budget", async () => {
    const err = new TypeError("boom");
    const fetchImpl = jest.fn().mockRejectedValue(err);
    const profile = { maxAttempts: 2, baseMs: 100, capMs: 500, timeoutMs: 1000 };

    await expect(apiGet(baseOpts({ fetchImpl, profile }))).rejects.toBe(err);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("apiGet — per-attempt timeout", () => {
  it("aborts a hung GET after timeoutMs so the attempt fails instead of hanging forever", async () => {
    // A fetch that never resolves on its own; it only settles when its AbortSignal fires —
    // exactly the dead-socket case the timeout exists for. A tiny real timeoutMs lets the
    // AbortController abort it. maxAttempts=1 so there's no backoff to coordinate.
    const fetchImpl = jest.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const profile = { maxAttempts: 1, baseMs: 1, capMs: 1, timeoutMs: 5 };

    await expect(
      apiGet(baseOpts({ fetchImpl, profile })),
    ).rejects.toThrow("aborted");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("apiGet — default fetch", () => {
  it("falls back to the global fetch when no fetchImpl is injected", async () => {
    const res = { ok: true, status: 200 };
    const g = globalThis as unknown as { fetch: jest.Mock };
    const original = g.fetch;
    g.fetch = jest.fn().mockResolvedValue(res);
    try {
      await expect(
        apiGet({ url: "http://x/scorecard", token: "t", sleep: noSleep, rng }),
      ).resolves.toBe(res);
      expect(g.fetch).toHaveBeenCalledTimes(1);
    } finally {
      g.fetch = original;
    }
  });
});
