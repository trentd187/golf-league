// __tests__/utils/sentry.test.ts
// Unit tests for the Sentry helpers in utils/sentry.ts. The @sentry/react-native
// SDK is replaced by the manual mock in __mocks__/@sentry/react-native.js, so these
// tests assert on the options we build and the SDK calls we make — without the
// native module.

import * as Sentry from "@sentry/react-native";
import {
  resolveSentryEnvironment,
  buildSentryOptions,
  syncSentryUser,
  reportQueryError,
  reportMutationError,
  reportSaveFailure,
  reportSaveReconciled,
  reportCreateFailure,
  reportCreateReconciled,
  addCreateBreadcrumb,
  reportWsLifecycle,
  reportWsError,
  addSaveBreadcrumb,
  initSentry,
} from "@/utils/sentry";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("resolveSentryEnvironment", () => {
  it("prefers the explicit environment when provided", () => {
    expect(resolveSentryEnvironment("preview", true)).toBe("preview");
    expect(resolveSentryEnvironment("production", true)).toBe("production");
  });

  it("falls back to development when no explicit value and __DEV__ is true", () => {
    expect(resolveSentryEnvironment(undefined, true)).toBe("development");
    expect(resolveSentryEnvironment("", true)).toBe("development");
  });

  it("falls back to production when no explicit value and __DEV__ is false", () => {
    expect(resolveSentryEnvironment(undefined, false)).toBe("production");
  });
});

describe("buildSentryOptions", () => {
  it("passes dsn and environment through and enables logs + PII", () => {
    const opts = buildSentryOptions({
      dsn: "https://abc@o1.ingest.sentry.io/2",
      environment: "production",
      isDev: false,
      platformOS: "android",
    });
    expect(opts.dsn).toBe("https://abc@o1.ingest.sentry.io/2");
    expect(opts.environment).toBe("production");
    expect(opts.enableLogs).toBe(true);
    expect(opts.sendDefaultPii).toBe(true);
  });

  it("samples all traces/sessions in dev and a fraction in prod", () => {
    const dev = buildSentryOptions({
      dsn: undefined,
      environment: "development",
      isDev: true,
      platformOS: "ios",
    });
    expect(dev.tracesSampleRate).toBe(1.0);
    expect(dev.replaysSessionSampleRate).toBe(1.0);

    const prod = buildSentryOptions({
      dsn: undefined,
      environment: "production",
      isDev: false,
      platformOS: "ios",
    });
    expect(prod.tracesSampleRate).toBe(0.1);
    expect(prod.replaysSessionSampleRate).toBe(0.1);
    expect(prod.replaysOnErrorSampleRate).toBe(1.0);
  });

  it("samples all traces in the preview channel (low-volume league testing) but keeps its replay rate at the non-dev fraction", () => {
    const preview = buildSentryOptions({
      dsn: undefined,
      environment: "preview",
      isDev: false,
      platformOS: "android",
    });
    // Full traces so event-day Vegas/Best Ball rounds are fully captured…
    expect(preview.tracesSampleRate).toBe(1.0);
    // …but replay stays at the non-dev rate (only isDev forces 1.0).
    expect(preview.replaysSessionSampleRate).toBe(0.1);
  });

  it("disables session replay on web (rrweb crashed the renderer on avatar-heavy pages)", () => {
    const web = buildSentryOptions({
      dsn: undefined,
      environment: "development",
      isDev: true,
      platformOS: "web",
    });
    // No replay integration on web, and zero sampling so rrweb never records.
    expect(Sentry.browserReplayIntegration).not.toHaveBeenCalled();
    expect(Sentry.mobileReplayIntegration).not.toHaveBeenCalled();
    expect(web.replaysSessionSampleRate).toBe(0);
    expect(web.replaysOnErrorSampleRate).toBe(0);
  });

  it("uses the mobile replay integration on native", () => {
    buildSentryOptions({
      dsn: undefined,
      environment: "development",
      isDev: true,
      platformOS: "android",
    });
    expect(Sentry.mobileReplayIntegration).toHaveBeenCalled();
    expect(Sentry.browserReplayIntegration).not.toHaveBeenCalled();
  });
});

describe("syncSentryUser", () => {
  it("sets the Sentry user when a user is provided", () => {
    syncSentryUser({ id: "u1", email: "a@b.com" });
    expect(Sentry.setUser).toHaveBeenCalledWith({ id: "u1", email: "a@b.com" });
  });

  it("clears the Sentry user on sign-out", () => {
    syncSentryUser(null);
    expect(Sentry.setUser).toHaveBeenCalledWith(null);
  });
});

describe("reportQueryError", () => {
  // Override the global Response so `error instanceof Response` resolves against a
  // constructible stub in the test environment.
  class MockResponse {
    status: number;
    url: string;
    constructor(status: number, url = "http://localhost/api") {
      this.status = status;
      this.url = url;
    }
  }
  beforeAll(() => {
    (globalThis as unknown as { Response: unknown }).Response = MockResponse;
  });

  it("captures 5xx responses as an exception", () => {
    reportQueryError(new MockResponse(503));
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.logger.warn).not.toHaveBeenCalled();
  });

  it("logs 4xx responses as a warning, not an exception", () => {
    reportQueryError(new MockResponse(404));
    expect(Sentry.logger.warn).toHaveBeenCalledWith(
      "API client error",
      expect.objectContaining({ status: 404 }),
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("ignores successful responses (status < 400)", () => {
    reportQueryError(new MockResponse(200));
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.logger.warn).not.toHaveBeenCalled();
  });

  it("captures plain Error instances", () => {
    reportQueryError(new Error("boom"));
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("ignores non-Error, non-Response values", () => {
    reportQueryError("just a string");
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.logger.warn).not.toHaveBeenCalled();
  });
});

describe("reportMutationError", () => {
  // Each message a fetch transport failure surfaces with on the platforms we ship.
  // All should be captured as Issues so we can read the exact string off Sentry.
  it.each([
    "Network request failed",
    "Failed to fetch",
    "The network connection was lost",
    "The request timed out",
    "unexpected end of stream",
    "Canceled",
  ])("captures network rejection %p as a tagged exception", (message) => {
    reportMutationError(new Error(message));
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message }),
      expect.objectContaining({
        tags: expect.objectContaining({ mutation_error_kind: "network" }),
      }),
    );
    expect(Sentry.logger.warn).not.toHaveBeenCalled();
  });

  it("logs app-thrown errors as a warning, not an exception", () => {
    reportMutationError(new Error("Please select a golf course."));
    expect(Sentry.logger.warn).toHaveBeenCalledWith(
      "Mutation error (non-network)",
      expect.objectContaining({ message: "Please select a golf course." }),
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("includes the mutationKey label in context when provided", () => {
    reportMutationError(new Error("Network request failed"), ["create-round"]);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({ mutationKey: '["create-round"]' }),
      }),
    );
  });

  it("falls back to String() when the mutationKey is not JSON-serializable", () => {
    // A BigInt makes JSON.stringify throw, exercising the catch fallback.
    reportMutationError(new Error("Network request failed"), 7n);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({ mutationKey: "7" }),
      }),
    );
  });

  it("ignores non-Error, non-Response values", () => {
    reportMutationError(12345);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.logger.warn).not.toHaveBeenCalled();
  });
});

describe("reportSaveFailure", () => {
  const conn = {
    connectionType: "cellular",
    cellularGeneration: "4g",
    isInternetReachable: true,
  };

  it("captures a transport failure as save_kind network with connection + attempt extra", () => {
    reportSaveFailure(new Error("Network request failed"), {
      label: "scores",
      attempts: 5,
      elapsedMs: 1234,
      ...conn,
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Network request failed" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          error_source: "save",
          save_kind: "network",
          save_endpoint: "scores",
          connection_type: "cellular",
        }),
        extra: expect.objectContaining({
          attempts: 5,
          elapsedMs: 1234,
          cellularGeneration: "4g",
          isInternetReachable: true,
        }),
      }),
    );
  });

  it("captures an HTTP non-2xx as save_kind http carrying the status", () => {
    reportSaveFailure(new Error("Save failed: HTTP 500"), {
      label: "handicap",
      attempts: 3,
      elapsedMs: 800,
      httpStatus: 500,
      ...conn,
    });
    const [, ctx] = (Sentry.captureException as jest.Mock).mock.calls[0];
    expect(ctx.tags.save_kind).toBe("http");
    expect(ctx.tags.save_endpoint).toBe("handicap");
    expect(ctx.extra.httpStatus).toBe(500);
  });

  it("defaults connection_type to unknown when not provided", () => {
    reportSaveFailure(new Error("Network request failed"), {
      label: "hole-stats",
      attempts: 5,
      elapsedMs: 10,
    });
    const [, ctx] = (Sentry.captureException as jest.Mock).mock.calls[0];
    expect(ctx.tags.connection_type).toBe("unknown");
  });

  it("ignores non-Error values", () => {
    reportSaveFailure("nope", { label: "scores", attempts: 1, elapsedMs: 0 });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe("reportSaveReconciled", () => {
  it("records a recovered phantom save as an info message tagged save_outcome:reconciled", () => {
    reportSaveReconciled({
      label: "scores",
      attempts: 5,
      elapsedMs: 4200,
      connectionType: "cellular",
      cellularGeneration: "4g",
    });
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("reconciled"),
      expect.objectContaining({
        level: "info",
        tags: expect.objectContaining({
          error_source: "save",
          save_outcome: "reconciled",
          save_endpoint: "scores",
          connection_type: "cellular",
        }),
        extra: expect.objectContaining({
          attempts: 5,
          elapsedMs: 4200,
          cellularGeneration: "4g",
        }),
      }),
    );
  });

  it("defaults connection_type to unknown when omitted", () => {
    reportSaveReconciled({ label: "scores", attempts: 3, elapsedMs: 10 });
    const [, ctx] = (Sentry.captureMessage as jest.Mock).mock.calls[0];
    expect(ctx.tags.connection_type).toBe("unknown");
  });
});

describe("reportCreateFailure", () => {
  const conn = {
    connectionType: "cellular",
    cellularGeneration: "4g",
    isInternetReachable: true,
  };

  it("captures a transport failure as create_kind network tagged error_source:create", () => {
    reportCreateFailure(new Error("Network request failed"), {
      label: "round",
      attempts: 3,
      elapsedMs: 900,
      ...conn,
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Network request failed" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          error_source: "create",
          create_kind: "network",
          create_endpoint: "round",
          connection_type: "cellular",
        }),
        extra: expect.objectContaining({ attempts: 3, elapsedMs: 900, cellularGeneration: "4g" }),
      }),
    );
  });

  it("captures an HTTP non-2xx as create_kind http carrying the status", () => {
    reportCreateFailure(new Error("Create failed: HTTP 500"), {
      label: "event",
      attempts: 3,
      elapsedMs: 700,
      httpStatus: 500,
      ...conn,
    });
    const [, ctx] = (Sentry.captureException as jest.Mock).mock.calls[0];
    expect(ctx.tags.create_kind).toBe("http");
    expect(ctx.tags.create_endpoint).toBe("event");
    expect(ctx.extra.httpStatus).toBe(500);
  });

  it("defaults connection_type to unknown when not provided", () => {
    reportCreateFailure(new Error("Network request failed"), {
      label: "event",
      attempts: 3,
      elapsedMs: 10,
    });
    const [, ctx] = (Sentry.captureException as jest.Mock).mock.calls[0];
    expect(ctx.tags.connection_type).toBe("unknown");
  });

  it("ignores non-Error values", () => {
    reportCreateFailure("nope", { label: "event", attempts: 1, elapsedMs: 0 });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe("reportCreateReconciled", () => {
  it("records a recovered phantom create as an info message tagged create_outcome:reconciled", () => {
    reportCreateReconciled({
      label: "round",
      attempts: 3,
      elapsedMs: 2100,
      connectionType: "cellular",
      cellularGeneration: "4g",
    });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("reconciled"),
      expect.objectContaining({
        level: "info",
        tags: expect.objectContaining({
          error_source: "create",
          create_outcome: "reconciled",
          create_endpoint: "round",
          connection_type: "cellular",
        }),
        extra: expect.objectContaining({ attempts: 3, elapsedMs: 2100, cellularGeneration: "4g" }),
      }),
    );
  });

  it("defaults connection_type to unknown when omitted", () => {
    reportCreateReconciled({ label: "round", attempts: 3, elapsedMs: 10 });
    const [, ctx] = (Sentry.captureMessage as jest.Mock).mock.calls[0];
    expect(ctx.tags.connection_type).toBe("unknown");
  });
});

describe("addCreateBreadcrumb", () => {
  it("adds a create breadcrumb at warning level when a retry follows", () => {
    addCreateBreadcrumb({
      label: "event",
      attempt: 1,
      nextDelayMs: 500,
      message: "Network request failed",
    });
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "create",
        level: "warning",
        data: expect.objectContaining({ label: "event", attempt: 1, nextDelayMs: 500 }),
      }),
    );
  });

  it("uses error level on the final attempt (nextDelayMs null)", () => {
    addCreateBreadcrumb({ label: "round", attempt: 3, nextDelayMs: null, message: "boom" });
    const arg = (Sentry.addBreadcrumb as jest.Mock).mock.calls[0][0];
    expect(arg.level).toBe("error");
  });
});

describe("reportWsLifecycle", () => {
  it("drops an info breadcrumb on connect (no Issue/log noise)", () => {
    reportWsLifecycle("connected", { roundId: "r1" });
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: "ws", level: "info" }),
    );
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("drops a warning breadcrumb on a reconnect attempt with attempt + delay", () => {
    reportWsLifecycle("reconnect_attempt", {
      roundId: "r1",
      attempt: 2,
      delayMs: 1500,
    });
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "ws",
        level: "warning",
        data: expect.objectContaining({ attempt: 2, delayMs: 1500 }),
      }),
    );
  });

  it("logs a warning (not an Issue) on disconnect with code + reason", () => {
    reportWsLifecycle("disconnected", {
      roundId: "r1",
      code: 1006,
      reason: "abnormal",
    });
    expect(Sentry.logger.warn).toHaveBeenCalledWith(
      "ws disconnected",
      expect.objectContaining({ event: "ws.disconnected", code: 1006 }),
    );
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("captures an Issue tagged ws_state:gave_up when reconnects are exhausted", () => {
    reportWsLifecycle("gave_up", { roundId: "r1", attempt: 8 });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("gave up"),
      expect.objectContaining({
        level: "warning",
        tags: expect.objectContaining({
          error_source: "ws",
          ws_state: "gave_up",
        }),
        extra: expect.objectContaining({ roundId: "r1", attempts: 8 }),
      }),
    );
  });
});

describe("reportWsError", () => {
  it("captures an Error as an Issue tagged error_source:ws", () => {
    reportWsError(new Error("bad frame"), "r1");
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { error_source: "ws" },
        extra: { roundId: "r1" },
      }),
    );
  });

  it("ignores non-Error values", () => {
    reportWsError("just a string", "r1");
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe("addSaveBreadcrumb", () => {
  it("adds a save breadcrumb at warning level when a retry follows", () => {
    addSaveBreadcrumb({
      label: "scores",
      attempt: 1,
      nextDelayMs: 500,
      message: "Network request failed",
    });
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "save",
        level: "warning",
        data: expect.objectContaining({ label: "scores", attempt: 1, nextDelayMs: 500 }),
      }),
    );
  });

  it("uses error level on the final attempt (nextDelayMs null)", () => {
    addSaveBreadcrumb({
      label: "handicap",
      attempt: 3,
      nextDelayMs: null,
      message: "boom",
    });
    const arg = (Sentry.addBreadcrumb as jest.Mock).mock.calls[0][0];
    expect(arg.level).toBe("error");
  });
});

describe("initSentry", () => {
  it("initialises the SDK with the resolved options", () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://x@o1.ingest.sentry.io/9";
    initSentry();
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    const passed = (Sentry.init as jest.Mock).mock.calls[0][0];
    expect(passed.dsn).toBe("https://x@o1.ingest.sentry.io/9");
    expect(passed.enableLogs).toBe(true);
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;
  });
});
