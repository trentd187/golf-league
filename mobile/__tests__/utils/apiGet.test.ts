// __tests__/utils/apiGet.test.ts
// Unit tests for the resilient GET helper in utils/apiGet.ts — the read counterpart to
// savePut/savePost. fetch, sleep, and rng are injected so the tests run deterministically
// with no real network, timers, or randomness. The key behaviors: a per-attempt timeout +
// jittered-backoff retry over TRANSPORT failures, but NO retry of a returned non-2xx.

import { apiGet, apiGetJson, RECONCILE_GET, READ_GET } from "@/utils/apiGet";
import { ApiError } from "@/utils/apiError";
import { reportReadFailure, addReadBreadcrumb } from "@/utils/sentry";

jest.mock("@/utils/sentry", () => ({
  reportReadFailure: jest.fn(),
  addReadBreadcrumb: jest.fn(),
}));

const mockReportReadFailure = reportReadFailure as jest.Mock;
const mockAddReadBreadcrumb = addReadBreadcrumb as jest.Mock;

const noSleep = jest.fn().mockResolvedValue(undefined);
const rng = () => 0; // every Full-Jitter delay collapses to 0
// A stubbed NetInfo so the failure-path connection snapshot never touches the real module.
const netInfoFetch = jest.fn().mockResolvedValue({ type: "cellular", isInternetReachable: false });

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    url: "http://localhost:8080/api/v1/rounds/r1/scorecard",
    token: "jwt-123",
    sleep: noSleep,
    rng,
    netInfoFetch,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  noSleep.mockResolvedValue(undefined);
  netInfoFetch.mockResolvedValue({ type: "cellular", isInternetReachable: false });
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

  it("rethrows a REPORTED, status-less ApiError after exhausting maxAttempts on the transport", async () => {
    const err = new TypeError("Network request failed");
    const fetchImpl = jest.fn().mockRejectedValue(err);

    // The original error is re-thrown as an ApiError so downstream code can tell a transport
    // failure (no status) from a server rejection, and so the QueryCache handler knows the
    // read path already reported it (reported: true) and won't file a duplicate Sentry event.
    const rejection: ApiError = await apiGet(baseOpts({ fetchImpl })).then(
      () => { throw new Error("expected a rejection"); },
      (e) => e,
    );
    expect(rejection).toBeInstanceOf(ApiError);
    expect(rejection.message).toBe("Network request failed");
    expect(rejection.status).toBeUndefined(); // no status ⇒ never got a response
    expect(rejection.reported).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(RECONCILE_GET.maxAttempts);
  });
});

describe("apiGet — custom profile", () => {
  it("honors a caller-supplied attempt budget", async () => {
    const err = new TypeError("boom");
    const fetchImpl = jest.fn().mockRejectedValue(err);
    const profile = { maxAttempts: 2, baseMs: 100, capMs: 500, timeoutMs: 1000 };

    await expect(apiGet(baseOpts({ fetchImpl, profile }))).rejects.toThrow("boom");
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
        apiGet({ url: "http://x/scorecard", token: "t", sleep: noSleep, rng, netInfoFetch }),
      ).resolves.toBe(res);
      expect(g.fetch).toHaveBeenCalledTimes(1);
    } finally {
      g.fetch = original;
    }
  });
});

// ─── Telemetry: the gap this change closes ────────────────────────────────────
// Before this work the read path emitted NOTHING. A GET that hung on a dead cellular
// socket produced no Sentry signal at all — the app just sat on a spinner.

describe("apiGet — telemetry", () => {
  it("breadcrumbs every failed attempt, then reports the exhausted read with a connection snapshot", async () => {
    const err = new TypeError("Network request failed");
    const fetchImpl = jest.fn().mockRejectedValue(err);

    await expect(
      apiGet(baseOpts({ fetchImpl, label: "scorecard" })),
    ).rejects.toThrow("Network request failed");

    // One breadcrumb per failed attempt; the last carries nextDelayMs: null (no retry left).
    expect(mockAddReadBreadcrumb).toHaveBeenCalledTimes(RECONCILE_GET.maxAttempts);
    const lastCrumb = mockAddReadBreadcrumb.mock.calls.at(-1)![0];
    expect(lastCrumb).toMatchObject({ label: "scorecard", nextDelayMs: null });

    // The failure report has no httpStatus — that's what marks it a TRANSPORT failure
    // (we never got a response) rather than a server rejection.
    expect(mockReportReadFailure).toHaveBeenCalledTimes(1);
    const [reportedErr, ctx] = mockReportReadFailure.mock.calls[0];
    expect(reportedErr).toBe(err); // reported with the ORIGINAL error, before wrapping
    expect(ctx).toMatchObject({
      label: "scorecard",
      attempts: RECONCILE_GET.maxAttempts,
      connectionType: "cellular",
    });
    expect(ctx.httpStatus).toBeUndefined();
  });

  it("stays silent on a successful read", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    await apiGet(baseOpts({ fetchImpl, label: "scorecard" }));

    expect(mockAddReadBreadcrumb).not.toHaveBeenCalled();
    expect(mockReportReadFailure).not.toHaveBeenCalled();
    // The connection snapshot is lazy — never read on the happy path.
    expect(netInfoFetch).not.toHaveBeenCalled();
  });
});

// ─── Read-shaped POST ─────────────────────────────────────────────────────────
// POST /courses/search-external is a query in everything but HTTP verb. Routing it through
// the read path keeps it tagged error_source:read and skips the Idempotency-Key a real
// create needs — it creates nothing.

describe("apiGet — read-shaped POST", () => {
  it("sends the body with a Content-Type when method is POST", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    await apiGet(
      baseOpts({ fetchImpl, method: "POST", body: { query: "pebble" }, label: "course_search" }),
    );

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ query: "pebble" });
  });

  it("omits Content-Type and body on a plain GET", async () => {
    // Some proxies treat a Content-Type on a bodyless GET as malformed.
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    await apiGet(baseOpts({ fetchImpl }));

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers["Content-Type"]).toBeUndefined();
    expect(init.body).toBeUndefined();
  });
});

// ─── apiGetJson — what every queryFn calls ────────────────────────────────────

describe("apiGetJson", () => {
  function jsonOpts(overrides: Record<string, unknown> = {}) {
    return { ...baseOpts(overrides), label: "scorecard" } as Parameters<typeof apiGetJson>[0];
  }

  it("returns parsed JSON on success and defaults to the READ_GET profile", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ players: [{ id: "p1" }] }),
    });

    await expect(apiGetJson(jsonOpts({ fetchImpl }))).resolves.toEqual({
      players: [{ id: "p1" }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(READ_GET.maxAttempts).toBeGreaterThan(1);
  });

  it("throws the API's own error message so the screen shows something meaningful", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "you are not in this round" }),
    });

    await expect(apiGetJson(jsonOpts({ fetchImpl }))).rejects.toThrow(
      "you are not in this round",
    );
    // A non-2xx is never retried — a 403 won't heal.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to a status message when the error body isn't usable JSON", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    });

    await expect(apiGetJson(jsonOpts({ fetchImpl }))).rejects.toThrow("HTTP 500");
  });

  it("reports a non-2xx WITH its httpStatus, so a server rejection is distinguishable from a dropped connection", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
    });

    await expect(apiGetJson(jsonOpts({ fetchImpl }))).rejects.toThrow("boom");

    expect(mockReportReadFailure).toHaveBeenCalledTimes(1);
    const [, ctx] = mockReportReadFailure.mock.calls[0];
    expect(ctx).toMatchObject({ label: "scorecard", httpStatus: 500 });
  });
});
