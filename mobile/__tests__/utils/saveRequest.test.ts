// __tests__/utils/saveRequest.test.ts
// Unit tests for the savePut chokepoint in utils/saveRequest.ts. Every collaborator
// (fetch, NetInfo, the Sentry reporters, sleep, rng, clock) is injected so the tests
// run deterministically with no network, no real timers, and no real randomness.

import {
  savePut,
  BACKGROUND_SAVE,
  FOREGROUND_SAVE,
} from "@/utils/saveRequest";
// Jest auto-applies the manual mock in __mocks__/@react-native-community/netinfo.js,
// so this import is the mock — used to drive the production defaultNetInfoFetch path
// (the tests above inject netInfoFetch directly and never touch it).
import NetInfo from "@react-native-community/netinfo";

const noSleep = jest.fn().mockResolvedValue(undefined);
const rng = () => 0; // every Full-Jitter delay collapses to 0
const okResponse = { ok: true, status: 200 };

// Base injectables shared by most tests; individual tests override fetchImpl etc.
function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    url: "http://localhost:8080/api/v1/rounds/r1/scores",
    token: "jwt-123",
    body: { scores: [{ hole: 1, strokes: 4 }] },
    label: "scores",
    sleep: noSleep,
    rng,
    report: jest.fn(),
    breadcrumb: jest.fn(),
    netInfoFetch: jest.fn().mockResolvedValue({
      type: "cellular",
      isInternetReachable: true,
      details: { cellularGeneration: "4g" },
    }),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  noSleep.mockResolvedValue(undefined);
});

describe("savePut — happy path", () => {
  it("issues one PUT with bearer auth + JSON body and resolves without retry", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse);
    const opts = baseOpts({ fetchImpl });

    await expect(savePut(opts)).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(opts.url);
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer jwt-123");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify(opts.body));
    expect(init.signal).toBeDefined(); // AbortController wired
  });

  it("does not report, breadcrumb, sleep, or read NetInfo on success", async () => {
    const opts = baseOpts({ fetchImpl: jest.fn().mockResolvedValue(okResponse) });
    await savePut(opts);
    expect(opts.report).not.toHaveBeenCalled();
    expect(opts.breadcrumb).not.toHaveBeenCalled();
    expect(noSleep).not.toHaveBeenCalled();
    expect(opts.netInfoFetch).not.toHaveBeenCalled(); // lazy: failure-only
  });
});

describe("savePut — idempotency key", () => {
  it("sends a stable Idempotency-Key header reused across retries", async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error("Network request failed"))
      .mockResolvedValue(okResponse);
    const opts = baseOpts({
      fetchImpl,
      retry: BACKGROUND_SAVE,
      genKey: () => "fixed-key-123",
    });

    await savePut(opts);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstKey = fetchImpl.mock.calls[0][1].headers["Idempotency-Key"];
    const secondKey = fetchImpl.mock.calls[1][1].headers["Idempotency-Key"];
    expect(firstKey).toBe("fixed-key-123");
    expect(secondKey).toBe("fixed-key-123"); // same key on the retry → backend can dedupe
  });

  it("mints a real key when none is injected", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse);
    await savePut(baseOpts({ fetchImpl, genKey: undefined }));
    const key = fetchImpl.mock.calls[0][1].headers["Idempotency-Key"];
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("savePut — transient failure then success", () => {
  it("retries a transport rejection and succeeds without reporting", async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error("Network request failed"))
      .mockResolvedValue(okResponse);
    const opts = baseOpts({ fetchImpl, retry: BACKGROUND_SAVE });

    await expect(savePut(opts)).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalledTimes(1); // one backoff before the success
    expect(opts.report).not.toHaveBeenCalled(); // recovered → no Issue
    // The transient failure still leaves a breadcrumb trail.
    expect(opts.breadcrumb).toHaveBeenCalledTimes(1);
    expect(opts.breadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ label: "scores", attempt: 1 }),
    );
  });
});

describe("savePut — network exhaustion", () => {
  it("reports a network failure with connection + attempts + elapsed, then rethrows", async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(new Error("Network request failed"));
    let clock = 1000;
    const now = jest.fn(() => clock);
    // First now() is the start; advance the clock so elapsedMs is observable.
    now.mockImplementationOnce(() => 1000);
    now.mockImplementation(() => 1450);
    const opts = baseOpts({ fetchImpl, retry: FOREGROUND_SAVE, now });

    await expect(savePut(opts)).rejects.toThrow("Network request failed");

    expect(fetchImpl).toHaveBeenCalledTimes(FOREGROUND_SAVE.maxAttempts); // 3
    expect(opts.netInfoFetch).toHaveBeenCalledTimes(1); // snapshot on failure only
    expect(opts.report).toHaveBeenCalledTimes(1);
    const [err, ctx] = (opts.report as jest.Mock).mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(ctx).toMatchObject({
      label: "scores",
      attempts: 3,
      httpStatus: undefined,
      connectionType: "cellular",
      cellularGeneration: "4g",
      isInternetReachable: true,
    });
    expect(ctx.elapsedMs).toBe(450);
  });

  it("emits a breadcrumb per attempt, the final one with nextDelayMs null", async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(new Error("Network request failed"));
    const opts = baseOpts({ fetchImpl, retry: FOREGROUND_SAVE });

    await expect(savePut(opts)).rejects.toThrow();

    expect(opts.breadcrumb).toHaveBeenCalledTimes(3);
    expect(opts.breadcrumb).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ attempt: 3, nextDelayMs: null }),
    );
  });
});

describe("savePut — phantom-save reconciliation", () => {
  it("suppresses a transport failure when reconcile confirms the write landed", async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(new Error("Network request failed"));
    const reconcile = jest.fn().mockResolvedValue(true);
    const reportReconciled = jest.fn();
    const opts = baseOpts({
      fetchImpl,
      retry: FOREGROUND_SAVE,
      reconcile,
      reportReconciled,
    });

    await expect(savePut(opts)).resolves.toBeUndefined(); // no throw → caller stays clean

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(opts.report).not.toHaveBeenCalled(); // no false Issue
    expect(reportReconciled).toHaveBeenCalledTimes(1);
    expect(reportReconciled).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "scores",
        attempts: FOREGROUND_SAVE.maxAttempts,
        connectionType: "cellular",
        cellularGeneration: "4g",
      }),
    );
  });

  it("reports + rethrows when reconcile says the write did not land", async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(new Error("Network request failed"));
    const reconcile = jest.fn().mockResolvedValue(false);
    const reportReconciled = jest.fn();
    const opts = baseOpts({ fetchImpl, retry: FOREGROUND_SAVE, reconcile, reportReconciled });

    await expect(savePut(opts)).rejects.toThrow("Network request failed");
    expect(opts.report).toHaveBeenCalledTimes(1);
    expect(reportReconciled).not.toHaveBeenCalled();
  });

  it("falls through to the failure path when reconcile itself throws (never masks the error)", async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(new Error("Network request failed"));
    const reconcile = jest.fn().mockRejectedValue(new Error("read-back boom"));
    const opts = baseOpts({ fetchImpl, retry: FOREGROUND_SAVE, reconcile });

    await expect(savePut(opts)).rejects.toThrow("Network request failed");
    expect(opts.report).toHaveBeenCalledTimes(1);
  });

  it("does NOT reconcile an HTTP non-2xx — a server rejection must surface", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    const reconcile = jest.fn().mockResolvedValue(true);
    const opts = baseOpts({ fetchImpl, retry: FOREGROUND_SAVE, reconcile });

    await expect(savePut(opts)).rejects.toThrow("HTTP 500");
    expect(reconcile).not.toHaveBeenCalled(); // only transport failures are recoverable
    expect(opts.report).toHaveBeenCalledTimes(1);
  });
});

describe("savePut — HTTP non-2xx", () => {
  it("retries a 5xx then reports save_kind http with the status (fixes silent-success)", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    const opts = baseOpts({
      fetchImpl,
      label: "handicap",
      retry: FOREGROUND_SAVE,
    });

    await expect(savePut(opts)).rejects.toThrow("HTTP 500");

    expect(fetchImpl).toHaveBeenCalledTimes(FOREGROUND_SAVE.maxAttempts);
    const [, ctx] = (opts.report as jest.Mock).mock.calls[0];
    expect(ctx).toMatchObject({ label: "handicap", httpStatus: 500, attempts: 3 });
  });
});

describe("savePut — per-attempt timeout", () => {
  it("aborts a hung attempt and retries with a fresh connection", async () => {
    // A fetch that only settles when its abort signal fires — models a dead socket.
    const fetchImpl = jest.fn((_url: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new Error("Aborted")),
        );
      });
    });
    // Tiny real timeout so the test runs fast; succeed once we've proven a retry.
    let calls = 0;
    const fetchOrSucceed = jest.fn((url: string, init: { signal: AbortSignal }) => {
      calls += 1;
      if (calls === 1) return fetchImpl(url, init);
      return Promise.resolve(okResponse);
    });
    const opts = baseOpts({
      fetchImpl: fetchOrSucceed,
      retry: { maxAttempts: 2, baseMs: 1, capMs: 1, timeoutMs: 5 },
    });

    await expect(savePut(opts)).resolves.toBeUndefined();
    expect(fetchOrSucceed).toHaveBeenCalledTimes(2); // aborted attempt 1, succeeded 2
    expect(opts.report).not.toHaveBeenCalled();
  });
});

describe("savePut — default NetInfo adapter", () => {
  // These omit the injected netInfoFetch so the production defaultNetInfoFetch runs,
  // adapting the real NetInfo.fetch() shape down to what reportSaveFailure records.
  it("reads cellularGeneration from cellular details on the default path", async () => {
    (NetInfo.fetch as jest.Mock).mockResolvedValueOnce({
      type: "cellular",
      isInternetReachable: true,
      details: { cellularGeneration: "5g", isConnectionExpensive: true },
    });
    const fetchImpl = jest.fn().mockRejectedValue(new Error("Network request failed"));
    const opts = baseOpts({ fetchImpl, retry: FOREGROUND_SAVE, netInfoFetch: undefined });

    await expect(savePut(opts)).rejects.toThrow();
    const [, ctx] = (opts.report as jest.Mock).mock.calls[0];
    expect(ctx).toMatchObject({
      connectionType: "cellular",
      cellularGeneration: "5g",
      isInternetReachable: true,
    });
  });

  it("yields null cellularGeneration when details lack it (e.g. wifi)", async () => {
    (NetInfo.fetch as jest.Mock).mockResolvedValueOnce({
      type: "wifi",
      isInternetReachable: true,
      details: { ssid: "Course-WiFi", isConnectionExpensive: false },
    });
    const fetchImpl = jest.fn().mockRejectedValue(new Error("Network request failed"));
    const opts = baseOpts({ fetchImpl, retry: FOREGROUND_SAVE, netInfoFetch: undefined });

    await expect(savePut(opts)).rejects.toThrow();
    const [, ctx] = (opts.report as jest.Mock).mock.calls[0];
    expect(ctx).toMatchObject({ connectionType: "wifi", cellularGeneration: null });
  });
});

describe("savePut — NetInfo resilience", () => {
  it("degrades to connection unknown when NetInfo.fetch rejects (never masks the save error)", async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(new Error("Network request failed"));
    const opts = baseOpts({
      fetchImpl,
      retry: FOREGROUND_SAVE,
      netInfoFetch: jest.fn().mockRejectedValue(new Error("netinfo boom")),
    });

    await expect(savePut(opts)).rejects.toThrow("Network request failed");
    const [, ctx] = (opts.report as jest.Mock).mock.calls[0];
    expect(ctx).toMatchObject({
      connectionType: "unknown",
      cellularGeneration: null,
      isInternetReachable: null,
    });
  });
});
