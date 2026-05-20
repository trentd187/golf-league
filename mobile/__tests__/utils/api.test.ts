// __tests__/utils/api.test.ts
// Unit tests for apiFetch in utils/api.ts.
// Verifies that observability headers are injected on every request and that
// the response is returned unchanged. fetch and expo-crypto are mocked.

// Valid hex UUID so traceId/spanId derivations in TelemetryClient produce
// well-formed strings (same mock as telemetry.test.ts for consistency).
jest.mock("expo-crypto", () => ({
  randomUUID: jest.fn(() => "deadbeef-dead-4bee-beef-deadbeefcafe"),
}));

jest.mock("@/constants/api", () => ({ API_URL: "http://localhost:8080" }));

// Minimal response shape: apiFetch reads response.headers.get("X-Trace-ID").
const makeMockResponse = (traceId?: string) => ({
  ok: true,
  status: 200,
  headers: {
    get: (key: string) => (key === "X-Trace-ID" && traceId ? traceId : null),
  },
});

const mockFetch = jest.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

import type { apiFetch as ApiFetch } from "@/utils/api";

// Each test gets a fresh module instance so the TelemetryClient singleton resets.
function isolatedApiFetch(): typeof ApiFetch {
  let fn!: typeof ApiFetch;
  jest.isolateModules(() => {
    fn = (require("@/utils/api") as { apiFetch: typeof ApiFetch }).apiFetch;
  });
  return fn;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue(makeMockResponse());
});

describe("apiFetch — observability headers", () => {
  it("injects a W3C traceparent header on every request", async () => {
    const fetch = isolatedApiFetch();
    await fetch("http://localhost:8080/api/v1/events");

    const [, opts] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const traceparent = (opts.headers as Headers).get("traceparent");
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("injects X-Correlation-ID set to the session ID", async () => {
    const fetch = isolatedApiFetch();
    await fetch("http://localhost:8080/api/v1/events");

    const [, opts] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    // sessionId is the first randomUUID() call in the TelemetryClient constructor.
    expect((opts.headers as Headers).get("X-Correlation-ID")).toBe(
      "deadbeef-dead-4bee-beef-deadbeefcafe",
    );
  });

  it("preserves caller-supplied headers alongside the injected ones", async () => {
    const fetch = isolatedApiFetch();
    await fetch("http://localhost:8080/api/v1/events", {
      headers: { Authorization: "Bearer my-jwt" },
    });

    const [, opts] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = opts.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer my-jwt");
    expect(headers.get("traceparent")).toBeTruthy();
    expect(headers.get("X-Correlation-ID")).toBeTruthy();
  });

  it("passes the original URL to fetch unchanged", async () => {
    const fetch = isolatedApiFetch();
    await fetch("http://localhost:8080/api/v1/me");

    const [url] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8080/api/v1/me");
  });
});

describe("apiFetch — response passthrough", () => {
  it("returns the Response from fetch unchanged", async () => {
    const mockResponse = makeMockResponse();
    mockFetch.mockResolvedValueOnce(mockResponse);
    const fetch = isolatedApiFetch();

    const result = await fetch("http://localhost:8080/api/v1/events");
    expect(result).toBe(mockResponse);
  });

  it("stores X-Trace-ID from the response on the telemetry client", async () => {
    mockFetch.mockResolvedValueOnce(makeMockResponse("backend-trace-abc123"));

    let setLastTraceIdSpy!: jest.SpyInstance;
    jest.isolateModules(() => {
      // Load telemetry and api from the same isolated scope so they share
      // the same TelemetryClient singleton.
      const telemetry = require("@/utils/telemetry") as {
        getTelemetryClient: () => { setLastTraceId: (id: string) => void };
      };
      setLastTraceIdSpy = jest.spyOn(telemetry.getTelemetryClient(), "setLastTraceId");

      const { apiFetch } = require("@/utils/api") as { apiFetch: typeof ApiFetch };
      void apiFetch("http://localhost:8080/api/v1/events");
    });

    // Allow the promise microtasks to settle.
    await Promise.resolve();

    expect(setLastTraceIdSpy).toHaveBeenCalledWith("backend-trace-abc123");
  });
});
