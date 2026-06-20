// __tests__/utils/savePost.test.ts
// Unit tests for the savePost chokepoint in utils/savePost.ts (non-idempotent POST
// creates). Every collaborator (fetch, NetInfo, the Sentry reporters, sleep, rng, clock)
// is injected so the tests run deterministically with no network, timers, or randomness.
// savePost is a thin adapter over runSaveWithRetry, so these also exercise the shared
// core (utils/saveWithRetry.ts) for the POST path.

import { savePost, CREATE_SAVE } from "@/utils/savePost";
// Jest auto-applies the manual NetInfo mock; used only by the default-adapter cases.
import NetInfo from "@react-native-community/netinfo";

const noSleep = jest.fn().mockResolvedValue(undefined);
const rng = () => 0; // every Full-Jitter delay collapses to 0

// okJson builds a fresh successful Response stub whose json() yields the created row.
function okJson(body: unknown) {
  return { ok: true, status: 201, json: () => Promise.resolve(body) };
}

// Base injectables shared by most tests; individual tests override fetchImpl etc.
function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    url: "http://localhost:8080/api/v1/rounds",
    token: "jwt-123",
    body: { scheduled_date: "2026-06-20", course_id: "c1" },
    label: "round",
    retry: CREATE_SAVE,
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

describe("savePost — happy path", () => {
  it("issues one POST with bearer auth + JSON body and resolves the parsed row", async () => {
    const created = { id: "round-1", name: "Wed Round" };
    const fetchImpl = jest.fn().mockResolvedValue(okJson(created));
    const opts = baseOpts({ fetchImpl });

    await expect(savePost(opts)).resolves.toEqual(created);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(opts.url);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer jwt-123");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.body).toBe(JSON.stringify(opts.body));
    expect(init.signal).toBeDefined(); // AbortController wired
  });

  it("does not report, breadcrumb, sleep, or read NetInfo on success", async () => {
    const opts = baseOpts({ fetchImpl: jest.fn().mockResolvedValue(okJson({ id: "x" })) });
    await savePost(opts);
    expect(opts.report).not.toHaveBeenCalled();
    expect(opts.breadcrumb).not.toHaveBeenCalled();
    expect(noSleep).not.toHaveBeenCalled();
    expect(opts.netInfoFetch).not.toHaveBeenCalled(); // lazy: failure-only
  });
});

describe("savePost — idempotency key", () => {
  it("sends a stable Idempotency-Key header reused across retries", async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error("Network request failed"))
      .mockResolvedValue(okJson({ id: "round-1" }));
    const opts = baseOpts({ fetchImpl, genKey: () => "fixed-key-123" });

    await savePost(opts);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstKey = fetchImpl.mock.calls[0][1].headers["Idempotency-Key"];
    const secondKey = fetchImpl.mock.calls[1][1].headers["Idempotency-Key"];
    expect(firstKey).toBe("fixed-key-123");
    // Same key on the retry → the backend durable store replays instead of re-creating.
    expect(secondKey).toBe("fixed-key-123");
  });
});

describe("savePost — transient failure then success", () => {
  it("retries a transport rejection and resolves the row without reporting", async () => {
    const created = { id: "round-1" };
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error("Network request failed"))
      .mockResolvedValue(okJson(created));
    const opts = baseOpts({ fetchImpl });

    await expect(savePost(opts)).resolves.toEqual(created);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalledTimes(1); // one backoff before the success
    expect(opts.report).not.toHaveBeenCalled(); // recovered → no Issue
    expect(opts.breadcrumb).toHaveBeenCalledTimes(1);
    expect(opts.breadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ label: "round", attempt: 1 }),
    );
  });
});

describe("savePost — network exhaustion", () => {
  it("reports a create failure with connection + attempts + elapsed, then rethrows", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("Network request failed"));
    const now = jest.fn();
    now.mockImplementationOnce(() => 1000); // start
    now.mockImplementation(() => 1450); // every later read
    const opts = baseOpts({ fetchImpl, now });

    await expect(savePost(opts)).rejects.toThrow("Network request failed");

    expect(fetchImpl).toHaveBeenCalledTimes(CREATE_SAVE.maxAttempts); // 3
    expect(opts.netInfoFetch).toHaveBeenCalledTimes(1); // snapshot on failure only
    expect(opts.report).toHaveBeenCalledTimes(1);
    const [err, ctx] = (opts.report as jest.Mock).mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(ctx).toMatchObject({
      label: "round",
      attempts: 3,
      httpStatus: undefined,
      connectionType: "cellular",
      cellularGeneration: "4g",
      isInternetReachable: true,
    });
    expect(ctx.elapsedMs).toBe(450);
  });

  it("emits a breadcrumb per attempt, the final one with nextDelayMs null", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("Network request failed"));
    const opts = baseOpts({ fetchImpl });

    await expect(savePost(opts)).rejects.toThrow();

    expect(opts.breadcrumb).toHaveBeenCalledTimes(3);
    expect(opts.breadcrumb).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ attempt: 3, nextDelayMs: null }),
    );
  });
});

describe("savePost — phantom-create reconciliation", () => {
  it("suppresses a transport failure and resolves the recovered row when reconcile finds it", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("Network request failed"));
    const recovered = { id: "round-recovered" };
    const reconcile = jest.fn().mockResolvedValue(recovered);
    const reportReconciled = jest.fn();
    const opts = baseOpts({ fetchImpl, reconcile, reportReconciled });

    await expect(savePost(opts)).resolves.toEqual(recovered); // caller gets the id, no throw

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(opts.report).not.toHaveBeenCalled(); // no false Issue
    expect(reportReconciled).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "round",
        attempts: CREATE_SAVE.maxAttempts,
        connectionType: "cellular",
        cellularGeneration: "4g",
      }),
    );
  });

  it("reports + rethrows when reconcile says the row did not land (null)", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("Network request failed"));
    const reconcile = jest.fn().mockResolvedValue(null);
    const reportReconciled = jest.fn();
    const opts = baseOpts({ fetchImpl, reconcile, reportReconciled });

    await expect(savePost(opts)).rejects.toThrow("Network request failed");
    expect(opts.report).toHaveBeenCalledTimes(1);
    expect(reportReconciled).not.toHaveBeenCalled();
  });

  it("falls through to the failure path when reconcile itself throws (never masks the error)", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("Network request failed"));
    const reconcile = jest.fn().mockRejectedValue(new Error("read-back boom"));
    const opts = baseOpts({ fetchImpl, reconcile });

    await expect(savePost(opts)).rejects.toThrow("Network request failed");
    expect(opts.report).toHaveBeenCalledTimes(1);
  });

  it("does NOT reconcile an HTTP non-2xx — a server rejection must surface", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 422 });
    const reconcile = jest.fn().mockResolvedValue({ id: "x" });
    const opts = baseOpts({ fetchImpl, reconcile });

    await expect(savePost(opts)).rejects.toThrow("HTTP 422");
    expect(reconcile).not.toHaveBeenCalled(); // only transport failures are recoverable
    expect(opts.report).toHaveBeenCalledTimes(1);
  });
});

describe("savePost — HTTP non-2xx", () => {
  it("retries a 5xx then reports create_kind http with the status", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    const opts = baseOpts({ fetchImpl, label: "event" });

    await expect(savePost(opts)).rejects.toThrow("HTTP 500");

    expect(fetchImpl).toHaveBeenCalledTimes(CREATE_SAVE.maxAttempts);
    const [, ctx] = (opts.report as jest.Mock).mock.calls[0];
    expect(ctx).toMatchObject({ label: "event", httpStatus: 500, attempts: 3 });
  });

  it("surfaces the API's error message from a non-2xx body instead of a bare status", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "scheduled_date required" }),
    });
    const opts = baseOpts({ fetchImpl, retry: { maxAttempts: 1, baseMs: 1, capMs: 1, timeoutMs: 5 } });

    await expect(savePost(opts)).rejects.toThrow("scheduled_date required");
  });

  it("falls back to the status when the error body is not JSON", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.reject(new Error("not json")),
    });
    const opts = baseOpts({ fetchImpl, retry: { maxAttempts: 1, baseMs: 1, capMs: 1, timeoutMs: 5 } });

    await expect(savePost(opts)).rejects.toThrow("HTTP 503");
  });
});

describe("savePost — per-attempt timeout", () => {
  it("aborts a hung attempt and retries with a fresh connection", async () => {
    // A fetch that only settles when its abort signal fires — models a dead socket.
    const hang = (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("Aborted")));
      });
    let calls = 0;
    const fetchImpl = jest.fn((url: string, init: { signal: AbortSignal }) => {
      calls += 1;
      if (calls === 1) return hang(url, init);
      return Promise.resolve(okJson({ id: "round-1" }));
    });
    const opts = baseOpts({
      fetchImpl,
      retry: { maxAttempts: 2, baseMs: 1, capMs: 1, timeoutMs: 5 },
    });

    await expect(savePost(opts)).resolves.toEqual({ id: "round-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // aborted attempt 1, succeeded 2
    expect(opts.report).not.toHaveBeenCalled();
  });
});

describe("savePost — default NetInfo adapter", () => {
  // Omits the injected netInfoFetch so the production default runs through the shared
  // connection-snapshot module, adapting NetInfo.fetch() to the reported shape.
  it("reads cellularGeneration from cellular details on the default path", async () => {
    (NetInfo.fetch as jest.Mock).mockResolvedValueOnce({
      type: "cellular",
      isInternetReachable: true,
      details: { cellularGeneration: "5g", isConnectionExpensive: true },
    });
    const fetchImpl = jest.fn().mockRejectedValue(new Error("Network request failed"));
    const opts = baseOpts({ fetchImpl, netInfoFetch: undefined });

    await expect(savePost(opts)).rejects.toThrow();
    const [, ctx] = (opts.report as jest.Mock).mock.calls[0];
    expect(ctx).toMatchObject({
      connectionType: "cellular",
      cellularGeneration: "5g",
      isInternetReachable: true,
    });
  });
});
