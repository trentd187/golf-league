// __tests__/utils/telemetry.test.ts
// Unit tests for TelemetryClient in utils/telemetry.ts.
// All tests are Tier 1 — no network or native device APIs required.
// expo-crypto and fetch are mocked below.

// Mock expo-crypto with a valid hex UUID so traceId/spanId derivations produce
// well-formed hex strings. The constructor calls randomUUID() twice (sessionId + traceId)
// and getTraceparent() calls it once more (spanId); all calls return the same value here.
jest.mock("expo-crypto", () => ({
  randomUUID: jest.fn(() => "deadbeef-dead-4bee-beef-deadbeefcafe"),
}));

// Mock the API_URL constant so flush() targets a stable URL in assertions.
jest.mock("@/constants/api", () => ({ API_URL: "http://localhost:8080" }));

// Mock fetch globally so flush() doesn't attempt a real network call.
const mockFetch = jest.fn(() => Promise.resolve({ ok: true }));
globalThis.fetch = mockFetch as unknown as typeof fetch;

import type { getTelemetryClient as GetTelemetryClient } from "@/utils/telemetry";

// freshClient returns a TelemetryClient from a clean module instance.
// jest.isolateModules runs its callback synchronously, so 'client' is set before return.
function freshClient(): ReturnType<typeof GetTelemetryClient> {
  let client!: ReturnType<typeof GetTelemetryClient>;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@/utils/telemetry") as { getTelemetryClient: typeof GetTelemetryClient };
    client = mod.getTelemetryClient();
  });
  return client;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("getTelemetryClient", () => {
  it("returns a TelemetryClient instance", () => {
    const client = freshClient();
    expect(client).toBeDefined();
  });

  it("returns the same instance on repeated calls within the same module (singleton)", () => {
    let a!: ReturnType<typeof GetTelemetryClient>;
    let b!: ReturnType<typeof GetTelemetryClient>;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("@/utils/telemetry") as { getTelemetryClient: typeof GetTelemetryClient };
      a = mod.getTelemetryClient();
      b = mod.getTelemetryClient();
    });
    expect(a).toBe(b);
  });
});

describe("TelemetryClient.getSessionId", () => {
  it("returns the UUID generated at construction", () => {
    const client = freshClient();
    expect(client.getSessionId()).toBe("deadbeef-dead-4bee-beef-deadbeefcafe");
  });
});

describe("TelemetryClient.log", () => {
  it("queues entries without flushing below the batch threshold", () => {
    const client = freshClient();
    const flushSpy = jest.spyOn(client as unknown as { flush(): Promise<void> }, "flush").mockResolvedValue(undefined);
    client.log("info", "test_event", "hello");
    expect(flushSpy).not.toHaveBeenCalled();
  });

  it("triggers an immediate flush when the queue reaches 20 entries", () => {
    const client = freshClient();
    const flushSpy = jest.spyOn(client as unknown as { flush(): Promise<void> }, "flush").mockResolvedValue(undefined);
    for (let i = 0; i < 20; i++) {
      client.log("info", "batch_test", `entry ${i}`);
    }
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it("always includes trace_id in the entry fields from the first log call", async () => {
    const client = freshClient();
    client.setTokenGetter(() => Promise.resolve("tok"));
    // Log before any API response has been received — trace_id must still be present.
    client.log("info", "startup_event", "app launched");
    await client.flush();

    const [, opts] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as {
      entries: { fields: Record<string, unknown> }[];
    };
    expect(body.entries[0].fields.trace_id).toBeDefined();
    expect(typeof body.entries[0].fields.trace_id).toBe("string");
  });
});

describe("TelemetryClient convenience level methods", () => {
  it("debug, info, warn, error all delegate to log with the correct level", () => {
    const client = freshClient();
    const logSpy = jest.spyOn(client, "log");

    client.debug("ev", "debug msg");
    client.info("ev", "info msg");
    client.warn("ev", "warn msg");
    client.error("ev", "error msg");

    expect(logSpy).toHaveBeenCalledTimes(4);
    expect(logSpy).toHaveBeenNthCalledWith(1, "debug", "ev", "debug msg", undefined);
    expect(logSpy).toHaveBeenNthCalledWith(2, "info", "ev", "info msg", undefined);
    expect(logSpy).toHaveBeenNthCalledWith(3, "warn", "ev", "warn msg", undefined);
    expect(logSpy).toHaveBeenNthCalledWith(4, "error", "ev", "error msg", undefined);
  });
});

describe("TelemetryClient.setTokenGetter", () => {
  it("triggers a flush when entries are already queued", () => {
    const client = freshClient();
    const flushSpy = jest.spyOn(client as unknown as { flush(): Promise<void> }, "flush").mockResolvedValue(undefined);

    client.log("info", "ev", "queued before token");
    client.setTokenGetter(() => Promise.resolve("tok"));

    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it("does not trigger a flush when the queue is empty", () => {
    const client = freshClient();
    const flushSpy = jest.spyOn(client as unknown as { flush(): Promise<void> }, "flush").mockResolvedValue(undefined);

    // No log() calls — queue is empty.
    client.setTokenGetter(() => Promise.resolve("tok"));

    expect(flushSpy).not.toHaveBeenCalled();
  });
});

describe("TelemetryClient.getTraceparent", () => {
  it("returns a string in W3C traceparent format (00-traceId-spanId-01)", () => {
    const client = freshClient();
    expect(client.getTraceparent()).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("trace ID portion is stable across multiple calls", () => {
    const client = freshClient();
    const first = client.getTraceparent();
    const second = client.getTraceparent();
    // traceparent format: "00-{traceId}-{spanId}-01" — no dashes inside traceId or spanId,
    // so split("-")[1] is exactly the 32-char trace ID segment.
    expect(first.split("-")[1]).toBe(second.split("-")[1]);
  });
});

describe("TelemetryClient.setLastTraceId", () => {
  it("stores the trace ID without throwing", () => {
    const client = freshClient();
    expect(() => client.setLastTraceId("abc-trace-123")).not.toThrow();
  });
});

describe("TelemetryClient.flush", () => {
  it("does nothing when no token getter is registered", async () => {
    const client = freshClient();
    client.log("info", "ev", "msg");
    await client.flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does nothing when the queue is empty", async () => {
    const client = freshClient();
    client.setTokenGetter(() => Promise.resolve("tok"));
    await client.flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends queued entries to the telemetry endpoint", async () => {
    const client = freshClient();
    client.setTokenGetter(() => Promise.resolve("my-jwt"));
    client.log("info", "ev", "msg");
    await client.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8080/api/v1/telemetry/logs");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string) as { entries: { level: string }[] };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].level).toBe("info");
  });

  it("includes the Authorization header with the token", async () => {
    const client = freshClient();
    client.setTokenGetter(() => Promise.resolve("bearer-token"));
    client.log("debug", "ev", "msg");
    await client.flush();

    const [, opts] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer bearer-token");
  });

  it("re-queues entries when the token getter throws", async () => {
    const client = freshClient();
    client.setTokenGetter(() => Promise.reject(new Error("auth error")));
    client.log("warn", "ev", "important");

    await client.flush();

    // fetch must not have been called — entries were re-queued on token failure.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("re-queues entries when the token getter returns null", async () => {
    const client = freshClient();
    client.setTokenGetter(() => Promise.resolve(null));
    client.log("error", "ev", "msg");
    await client.flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("TelemetryClient.stopTimer", () => {
  it("cancels the pending debounce timer without throwing", () => {
    const client = freshClient();
    client.log("info", "ev", "arm the timer");
    expect(() => client.stopTimer()).not.toThrow();
  });

  it("is a no-op when no timer is active", () => {
    const client = freshClient();
    expect(() => client.stopTimer()).not.toThrow();
  });
});
