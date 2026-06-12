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
