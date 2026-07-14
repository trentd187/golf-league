// __tests__/utils/supabaseFetch.test.ts
// Unit tests for utils/supabaseFetch.ts — the hardened fetch injected into the Supabase
// client. fetch, sleep, rng, NetInfo, and the reporters are all injected so the tests run
// deterministically with no real network, timers, or randomness.
//
// The behaviors that matter:
//   1. A per-attempt timeout exists at all (there was none: an expired-token refresh could
//      hang forever IN FRONT OF every hardened API call).
//   2. Transport failures are retried ONLY on idempotent requests. Retrying POST /auth/v1/otp
//      would send a second magic-link email; retrying /verify would burn a one-time code.
//   3. A failure is reported, and the ORIGINAL error is rethrown (supabase-js inspects it).

import { createSupabaseFetch, classifySupabaseRequest } from "@/utils/supabaseFetch";

const noSleep = jest.fn().mockResolvedValue(undefined);
const rng = () => 0; // every Full-Jitter delay collapses to 0
const netInfoFetch = jest.fn().mockResolvedValue({ type: "cellular", isInternetReachable: false });
const report = jest.fn();
const breadcrumb = jest.fn();

const AUTH = "https://proj.supabase.co/auth/v1";
const STORAGE = "https://proj.supabase.co/storage/v1/object/avatars/u1.jpg";

function makeFetch(fetchImpl: jest.Mock) {
  return createSupabaseFetch({ fetchImpl, sleep: noSleep, rng, netInfoFetch, report, breadcrumb });
}

beforeEach(() => {
  jest.clearAllMocks();
  noSleep.mockResolvedValue(undefined);
  netInfoFetch.mockResolvedValue({ type: "cellular", isInternetReachable: false });
});

describe("classifySupabaseRequest — the retry policy", () => {
  it("retries the token refresh even though it is a POST (replaying it is safe)", () => {
    const plan = classifySupabaseRequest(`${AUTH}/token?grant_type=refresh_token`, "POST");
    expect(plan.retryable).toBe(true);
    expect(plan.maxAttempts).toBeGreaterThan(1);
    expect(plan.label).toBe("auth.token_refresh");
    expect(plan.kind).toBe("auth");
  });

  it("does NOT retry the OTP send — a retry sends a second magic-link email", () => {
    const plan = classifySupabaseRequest(`${AUTH}/otp`, "POST");
    expect(plan.retryable).toBe(false);
    expect(plan.maxAttempts).toBe(1);
    expect(plan.label).toBe("auth.otp");
  });

  it("does NOT retry OTP verification — a retry burns the one-time code", () => {
    const plan = classifySupabaseRequest(`${AUTH}/verify`, "POST");
    expect(plan.retryable).toBe(false);
    expect(plan.maxAttempts).toBe(1);
  });

  it("does NOT retry a storage upload, but does retry a download", () => {
    expect(classifySupabaseRequest(STORAGE, "POST").retryable).toBe(false);
    expect(classifySupabaseRequest(STORAGE, "POST").label).toBe("storage.upload");
    expect(classifySupabaseRequest(STORAGE, "GET").retryable).toBe(true);
    expect(classifySupabaseRequest(STORAGE, "GET").label).toBe("storage.download");
  });

  it("keeps the one-time code and any token out of the label (it becomes a Sentry tag)", () => {
    const plan = classifySupabaseRequest(`${AUTH}/verify?token=secret-otp-123`, "POST");
    expect(plan.label).toBe("auth.verify");
    expect(plan.label).not.toContain("secret-otp-123");
  });

  it("labels the rest of the auth surface without leaking the path", () => {
    expect(classifySupabaseRequest(`${AUTH}/logout`, "POST").label).toBe("auth.logout");
    expect(classifySupabaseRequest(`${AUTH}/user`, "GET").label).toBe("auth.user");
    expect(classifySupabaseRequest(`${AUTH}/token?grant_type=password`, "POST").label).toBe(
      "auth.token",
    );
    expect(classifySupabaseRequest(`${AUTH}/magiclink`, "POST").label).toBe("auth.other");
  });

  it("gives a storage upload a longer timeout than an interactive auth call", () => {
    expect(classifySupabaseRequest(STORAGE, "POST").timeoutMs).toBeGreaterThan(
      classifySupabaseRequest(`${AUTH}/otp`, "POST").timeoutMs,
    );
  });

  it("falls back to the 'other' kind for a non-auth, non-storage URL (e.g. postgrest)", () => {
    const plan = classifySupabaseRequest("https://proj.supabase.co/rest/v1/things", "POST");
    expect(plan.kind).toBe("other");
    expect(plan.label).toBe("supabase.other");
    expect(plan.retryable).toBe(false); // a POST is not blind-retried, wherever it points
    expect(classifySupabaseRequest("https://proj.supabase.co/rest/v1/things", "GET").retryable).toBe(
      true,
    );
  });
});

describe("createSupabaseFetch — fetch's three input shapes", () => {
  // supabase-js calls fetch with a string, a URL, or a Request depending on the operation.
  // Misreading any of them would silently misclassify the request — e.g. treating the OTP
  // POST as a retryable GET, which sends a second magic-link email.
  it("reads the url and method from a URL object", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("Network request failed"));

    await expect(
      makeFetch(fetchImpl)(new URL(`${AUTH}/otp`), { method: "POST" }),
    ).rejects.toThrow();

    expect(fetchImpl).toHaveBeenCalledTimes(1); // classified as the non-retryable OTP send
    expect(report.mock.calls[0][1].label).toBe("auth.otp");
  });

  it("reads the url and method from a Request-like object when no init is given", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("Network request failed"));
    const request = { url: `${AUTH}/otp`, method: "POST" } as unknown as Request;

    await expect(makeFetch(fetchImpl)(request)).rejects.toThrow();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][1].label).toBe("auth.otp");
  });

  it("defaults a bare string input to GET (fetch's own default), so it is retryable", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("Network request failed"));

    await expect(makeFetch(fetchImpl)(`${AUTH}/user`)).rejects.toThrow();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("createSupabaseFetch — timeout", () => {
  it("passes an AbortSignal on every attempt so a hung request can be aborted", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    await makeFetch(fetchImpl)(`${AUTH}/token?grant_type=refresh_token`, { method: "POST" });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.signal).toBeDefined();
    expect(init.signal.aborted).toBe(false);
  });

  it("aborts the attempt when the caller's own signal aborts", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const fetchImpl = jest.fn().mockImplementation((_url, init) => {
      seen = init.signal;
      controller.abort(); // upstream cancels mid-flight
      return Promise.resolve({ ok: true, status: 200 });
    });

    await makeFetch(fetchImpl)(`${AUTH}/user`, { signal: controller.signal });

    expect(seen?.aborted).toBe(true);
  });
});

describe("createSupabaseFetch — retry", () => {
  it("retries a transport failure on the token refresh and resolves on a later attempt", async () => {
    const ok = { ok: true, status: 200 };
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error("Network request failed"))
      .mockResolvedValueOnce(ok);

    const res = await makeFetch(fetchImpl)(`${AUTH}/token?grant_type=refresh_token`, {
      method: "POST",
    });

    expect(res).toBe(ok);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(breadcrumb).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it("does NOT retry a failed OTP send — exactly one attempt, one email", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("Network request failed"));

    await expect(makeFetch(fetchImpl)(`${AUTH}/otp`, { method: "POST" })).rejects.toThrow(
      "Network request failed",
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-2xx: a 400 (bad code) is returned as-is for supabase-js to read", async () => {
    const res = { ok: false, status: 400 };
    const fetchImpl = jest.fn().mockResolvedValue(res);

    await expect(makeFetch(fetchImpl)(`${AUTH}/verify`, { method: "POST" })).resolves.toBe(res);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled(); // a bad OTP is user error, not a defect
  });
});

describe("createSupabaseFetch — telemetry", () => {
  it("reports exhaustion with the endpoint label, attempt count, and connection snapshot", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("Network request failed"));

    await expect(
      makeFetch(fetchImpl)(`${AUTH}/token?grant_type=refresh_token`, { method: "POST" }),
    ).rejects.toThrow("Network request failed");

    expect(report).toHaveBeenCalledTimes(1);
    const [err, ctx] = report.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(ctx.label).toBe("auth.token_refresh");
    expect(ctx.kind).toBe("auth");
    expect(ctx.attempts).toBe(3);
    expect(ctx.connectionType).toBe("cellular");
    // No httpStatus is what marks this a transport failure rather than a rejection.
    expect(ctx.httpStatus).toBeUndefined();
  });

  it("reports a 5xx (Supabase itself is broken) but still returns the Response", async () => {
    const res = { ok: false, status: 503 };
    const fetchImpl = jest.fn().mockResolvedValue(res);

    await expect(makeFetch(fetchImpl)(`${AUTH}/otp`, { method: "POST" })).resolves.toBe(res);

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][1].httpStatus).toBe(503);
  });

  it("rethrows the ORIGINAL error unwrapped — supabase-js inspects it to build its own", async () => {
    const original = new TypeError("Network request failed");
    const fetchImpl = jest.fn().mockRejectedValue(original);

    await expect(makeFetch(fetchImpl)(`${AUTH}/otp`, { method: "POST" })).rejects.toBe(original);
  });
});
