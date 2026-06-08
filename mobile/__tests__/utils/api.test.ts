// __tests__/utils/api.test.ts
// Unit tests for apiFetch in utils/api.ts. apiFetch is now a thin passthrough to
// the global fetch — Sentry's fetch instrumentation injects trace headers, so the
// wrapper adds nothing and must forward input/init unchanged and return the Response.

const mockFetch = jest.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

import { apiFetch } from "@/utils/api";

const mockResponse = { ok: true, status: 200 };

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue(mockResponse);
});

describe("apiFetch", () => {
  it("passes the URL through to fetch unchanged", async () => {
    await apiFetch("http://localhost:8080/api/v1/me");
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:8080/api/v1/me", undefined);
  });

  it("forwards the init object (method, headers, body) unchanged", async () => {
    const init = {
      method: "POST",
      headers: { Authorization: "Bearer my-jwt" },
      body: JSON.stringify({ a: 1 }),
    };
    await apiFetch("http://localhost:8080/api/v1/events", init);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/events",
      init,
    );
  });

  it("returns the Response from fetch unchanged", async () => {
    const result = await apiFetch("http://localhost:8080/api/v1/events");
    expect(result).toBe(mockResponse);
  });

  it("does not inject any observability headers", async () => {
    await apiFetch("http://localhost:8080/api/v1/events");
    const [, init] = mockFetch.mock.calls[0];
    // init is forwarded as-is (undefined here) — no Headers object is constructed.
    expect(init).toBeUndefined();
  });
});
