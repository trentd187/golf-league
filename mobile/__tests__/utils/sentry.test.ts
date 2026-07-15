// __tests__/utils/sentry.test.ts
// Unit tests for the Sentry helpers in utils/sentry.ts. The @sentry/react-native
// SDK is replaced by the manual mock in __mocks__/@sentry/react-native.js, so these
// tests assert on the options we build and the SDK calls we make — without the
// native module.

import * as Sentry from "@sentry/react-native";

// Mock expo-constants so initSentry sees build metadata in expoConfig.extra (the values
// app.config.js bakes in at build time). appOwnership is provided because sentry.ts reads
// it at module load to gate TTID instrumentation.
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    appOwnership: "standalone",
    expoConfig: { extra: { commitSha: "testsha", appVariant: "preview" } },
  },
}));

import {
  resolveSentryEnvironment,
  resolveBuildTags,
  buildSentryOptions,
  syncSentryUser,
  reportQueryError,
  reportMutationError,
  reportSaveFailure,
  reportSaveReconciled,
  reportCreateFailure,
  reportCreateReconciled,
  addCreateBreadcrumb,
  addSaveBreadcrumb,
  addStatFocusBreadcrumb,
  reportScorecardMergeSkipped,
  addScorecardLoadBreadcrumb,
  addScorecardRefetchBreadcrumb,
  reportSupabaseFailure,
  addSupabaseBreadcrumb,
  reportAuthFailure,
  reportStorageFailure,
  reportReadFailure,
  initSentry,
} from "@/utils/sentry";
import { ApiError } from "@/utils/apiError";

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

describe("resolveBuildTags", () => {
  it("maps commitSha and appVariant into build_commit / app_variant tags", () => {
    expect(
      resolveBuildTags({ commitSha: "abc1234", appVariant: "preview" }),
    ).toEqual({ build_commit: "abc1234", app_variant: "preview" });
  });

  it("omits tags whose values are missing, empty, or non-string", () => {
    expect(resolveBuildTags({ commitSha: "abc1234" })).toEqual({
      build_commit: "abc1234",
    });
    expect(resolveBuildTags({ commitSha: "", appVariant: "preview" })).toEqual({
      app_variant: "preview",
    });
    expect(resolveBuildTags({ commitSha: 123, appVariant: null })).toEqual({});
  });

  it("returns an empty object when extra is undefined or null (local dev / Expo Go)", () => {
    expect(resolveBuildTags(undefined)).toEqual({});
    expect(resolveBuildTags(null)).toEqual({});
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

  it("includes release only when provided (native omits it to keep the SDK auto-release)", () => {
    const withRelease = buildSentryOptions({
      dsn: undefined,
      environment: "development",
      isDev: false,
      platformOS: "web",
      release: "deadbeef",
    });
    expect(withRelease.release).toBe("deadbeef");

    const withoutRelease = buildSentryOptions({
      dsn: undefined,
      environment: "production",
      isDev: false,
      platformOS: "android",
    });
    expect("release" in withoutRelease).toBe(false);
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

describe("reportQueryError — no double-reporting", () => {
  it("skips an ApiError the read path already reported", () => {
    // apiGet reports its own failures with an endpoint label and a connection snapshot —
    // detail this generic handler cannot reconstruct. Without the `reported` guard every
    // failed read would produce TWO Sentry events.
    reportQueryError(new ApiError("Network request failed", { reported: true, label: "scorecard" }));
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.logger.warn).not.toHaveBeenCalled();
  });

  it("still reports an ApiError that was NOT already reported", () => {
    reportQueryError(new ApiError("something else", { reported: false }));
    expect(Sentry.captureException).toHaveBeenCalled();
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
  it("records a recovered phantom save as a structured LOG (not an Issue) tagged save_outcome:reconciled", () => {
    reportSaveReconciled({
      label: "scores",
      attempts: 5,
      elapsedMs: 4200,
      connectionType: "cellular",
      cellularGeneration: "4g",
    });
    // A recovered phantom must NOT open an Issue — it goes to searchable Logs.
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.logger.info).toHaveBeenCalledTimes(1);
    expect(Sentry.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("reconciled"),
      expect.objectContaining({
        event: "save.reconciled",
        error_source: "save",
        save_outcome: "reconciled",
        save_endpoint: "scores",
        connection_type: "cellular",
        attempts: 5,
        elapsedMs: 4200,
        cellularGeneration: "4g",
      }),
    );
  });

  it("defaults connection_type to unknown when omitted", () => {
    reportSaveReconciled({ label: "scores", attempts: 3, elapsedMs: 10 });
    const [, attrs] = (Sentry.logger.info as jest.Mock).mock.calls[0];
    expect(attrs.connection_type).toBe("unknown");
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
  it("records a recovered phantom create as a structured LOG (not an Issue) tagged create_outcome:reconciled", () => {
    reportCreateReconciled({
      label: "round",
      attempts: 3,
      elapsedMs: 2100,
      connectionType: "cellular",
      cellularGeneration: "4g",
    });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("reconciled"),
      expect.objectContaining({
        event: "create.reconciled",
        error_source: "create",
        create_outcome: "reconciled",
        create_endpoint: "round",
        connection_type: "cellular",
        attempts: 3,
        elapsedMs: 2100,
        cellularGeneration: "4g",
      }),
    );
  });

  it("defaults connection_type to unknown when omitted", () => {
    reportCreateReconciled({ label: "round", attempts: 3, elapsedMs: 10 });
    const [, attrs] = (Sentry.logger.info as jest.Mock).mock.calls[0];
    expect(attrs.connection_type).toBe("unknown");
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

describe("addStatFocusBreadcrumb", () => {
  it("records a scorecard breadcrumb with the field and editable state", () => {
    addStatFocusBreadcrumb("putts", true);
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "scorecard",
        level: "info",
        message: "stat putts focused",
        data: { field: "putts", editable: true },
      }),
    );
  });

  it("captures editable:false so a non-editable focus is visible in the trail", () => {
    addStatFocusBreadcrumb("first_putt_distance", false);
    const arg = (Sentry.addBreadcrumb as jest.Mock).mock.calls[0][0];
    expect(arg.data).toEqual({ field: "first_putt_distance", editable: false });
  });
});

describe("reportScorecardMergeSkipped", () => {
  it("logs a scorecard.merge_skipped warning with the degraded flags and cell counts", () => {
    reportScorecardMergeSkipped({
      roundId: "r1",
      scoresDegraded: false,
      statsDegraded: true,
      localScoreCells: 12,
      localStatCells: 30,
    });
    expect(Sentry.logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: "scorecard.merge_skipped",
        roundId: "r1",
        scores_degraded: false,
        stats_degraded: true,
        local_score_cells: 12,
        local_stat_cells: 30,
      }),
    );
  });
});

describe("addScorecardLoadBreadcrumb", () => {
  it("records a scorecard breadcrumb carrying the snapshot's player/score/stat counts", () => {
    addScorecardLoadBreadcrumb({ roundId: "r1", players: 4, scoreCells: 40, statCells: 18 });
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "scorecard",
        level: "info",
        data: { roundId: "r1", players: 4, scoreCells: 40, statCells: 18 },
      }),
    );
  });
});

describe("addScorecardRefetchBreadcrumb", () => {
  it("records a source-tagged breadcrumb and a sampled scorecard.refetch log", () => {
    // First call for this source → sampled log fires (n <= 3).
    addScorecardRefetchBreadcrumb("poll", "r1");
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "scorecard",
        level: "info",
        data: { source: "poll", roundId: "r1" },
      }),
    );
    expect(Sentry.logger.info).toHaveBeenCalledWith(
      "scorecard refetch",
      expect.objectContaining({ event: "scorecard.refetch", source: "poll", roundId: "r1" }),
    );
  });

  it("samples the log — a burst breadcrumbs every time but does not log every time", () => {
    (Sentry.addBreadcrumb as jest.Mock).mockClear();
    (Sentry.logger.info as jest.Mock).mockClear();
    // "hole_change" is unused above, so counts start at 0: calls 1-3 log, 4-24 do not.
    for (let i = 0; i < 10; i++) addScorecardRefetchBreadcrumb("hole_change", "r1");
    expect(Sentry.addBreadcrumb).toHaveBeenCalledTimes(10); // breadcrumb every time
    expect((Sentry.logger.info as jest.Mock).mock.calls.length).toBeLessThan(10); // log is sampled
  });
});

describe("reportSupabaseFailure", () => {
  const conn = {
    connectionType: "cellular",
    cellularGeneration: "4g",
    isInternetReachable: false,
  };

  it("captures a 5xx as an Issue — Supabase itself is broken", () => {
    reportSupabaseFailure(new Error("Supabase auth.otp failed: HTTP 503"), {
      label: "auth.otp",
      kind: "auth",
      attempts: 1,
      elapsedMs: 800,
      httpStatus: 503,
      ...conn,
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Supabase auth.otp failed: HTTP 503" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          error_source: "auth",
          supabase_endpoint: "auth.otp",
          supabase_kind: "http",
        }),
      }),
    );
  });

  // The token refresh is special: when it exhausts, every API call afterwards goes out with
  // an empty Bearer and 401s — which reads as ordinary 4xx noise. Escalate it so a fleet-wide
  // auth outage doesn't hide inside the warn logs.
  it("captures an exhausted token refresh as an Issue even on a transport failure", () => {
    reportSupabaseFailure(new Error("Network request failed"), {
      label: "auth.token_refresh",
      kind: "auth",
      attempts: 3,
      elapsedMs: 45000,
      ...conn,
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Network request failed" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          supabase_endpoint: "auth.token_refresh",
          supabase_kind: "network",
        }),
      }),
    );
    expect(Sentry.logger.warn).not.toHaveBeenCalled();
  });

  it("logs (does not file an Issue for) an ordinary transport failure on a storage upload", () => {
    reportSupabaseFailure(new Error("Network request failed"), {
      label: "storage.upload",
      kind: "storage",
      attempts: 1,
      elapsedMs: 30000,
      ...conn,
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.logger.warn).toHaveBeenCalledWith(
      "supabase request failed",
      expect.objectContaining({
        event: "supabase.request_failed",
        error_source: "storage",
        supabase_endpoint: "storage.upload",
      }),
    );
  });
});

describe("addSupabaseBreadcrumb", () => {
  it("marks a retryable attempt warning and the final give-up error", () => {
    addSupabaseBreadcrumb({
      label: "auth.token_refresh",
      attempt: 1,
      nextDelayMs: 400,
      message: "timeout",
    });
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: "supabase", level: "warning" }),
    );

    addSupabaseBreadcrumb({
      label: "auth.token_refresh",
      attempt: 3,
      nextDelayMs: null,
      message: "timeout",
    });
    expect(Sentry.addBreadcrumb).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: "supabase", level: "error" }),
    );
  });
});

describe("reportAuthFailure", () => {
  // A thrown getSession used to strand the app on a permanent blank screen — exceptional,
  // and worth an Issue.
  it("files an Issue for a fatal session failure, tagged with the stage", () => {
    reportAuthFailure(new Error("SecureStore read failed"), {
      stage: "root_session_restore",
      fatal: true,
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "SecureStore read failed" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          error_source: "auth",
          auth_stage: "root_session_restore",
        }),
      }),
    );
  });

  // An expired refresh token after a long absence is routine: the user re-signs in.
  it("logs a non-fatal session failure instead of alarming", () => {
    reportAuthFailure({ message: "Invalid Refresh Token" }, { stage: "get_token" });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.logger.warn).toHaveBeenCalledWith(
      "auth session unavailable",
      expect.objectContaining({
        event: "auth.session_unavailable",
        auth_stage: "get_token",
      }),
    );
  });
});

describe("reportReadFailure", () => {
  const conn = { connectionType: "wifi", cellularGeneration: null, isInternetReachable: true };

  // Routing is deliberately asymmetric. A 5xx is a real backend defect → Issue.
  it("files an Issue for a 5xx, tagged with the endpoint", () => {
    reportReadFailure(new ApiError("Request failed: HTTP 500", { status: 500 }), {
      label: "scorecard",
      attempts: 1,
      elapsedMs: 300,
      httpStatus: 500,
      ...conn,
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Request failed: HTTP 500" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          error_source: "read",
          read_kind: "http",
          read_endpoint: "scorecard",
        }),
      }),
    );
  });

  // A dropped GET on cellular is routine and the poll will repaint — an Issue per occurrence
  // would recreate exactly the alert flood the WebSocket used to produce.
  it("logs (does not file an Issue for) a transport failure", () => {
    reportReadFailure(new Error("Network request failed"), {
      label: "events",
      attempts: 3,
      elapsedMs: 12000,
      ...conn,
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.logger.warn).toHaveBeenCalledWith(
      "read failed after retries",
      expect.objectContaining({ event: "read.failed", read_kind: "network", read_endpoint: "events" }),
    );
  });
});

describe("reportStorageFailure", () => {
  // Never an Issue — the store falls back to defaults and the app keeps working. But never
  // silent either: a persistently failing write means the user's theme and list prefs revert
  // on every launch, and the old `.catch(() => {})` said nothing at all.
  it("logs a failed write with the area and operation, without filing an Issue", () => {
    reportStorageFailure(new Error("QuotaExceededError"), {
      area: "list_prefs",
      operation: "write",
      key: "list-prefs-storage",
    });

    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.logger.warn).toHaveBeenCalledWith(
      "persisted storage operation failed",
      expect.objectContaining({
        event: "storage.failed",
        error_source: "storage",
        storage_area: "list_prefs",
        storage_operation: "write",
      }),
    );
  });
});

describe("initSentry", () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;
    delete process.env.EXPO_PUBLIC_SENTRY_RELEASE;
  });

  it("initialises the SDK with the resolved options", () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://x@o1.ingest.sentry.io/9";
    initSentry();
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    const passed = (Sentry.init as jest.Mock).mock.calls[0][0];
    expect(passed.dsn).toBe("https://x@o1.ingest.sentry.io/9");
    expect(passed.enableLogs).toBe(true);
  });

  it("passes EXPO_PUBLIC_SENTRY_RELEASE through as the release (web source-map match)", () => {
    process.env.EXPO_PUBLIC_SENTRY_RELEASE = "deadbeef";
    initSentry();
    const passed = (Sentry.init as jest.Mock).mock.calls[0][0];
    expect(passed.release).toBe("deadbeef");
  });

  it("tags every event with the build's commit + variant from expoConfig.extra", () => {
    initSentry();
    expect(Sentry.setTag).toHaveBeenCalledWith("build_commit", "testsha");
    expect(Sentry.setTag).toHaveBeenCalledWith("app_variant", "preview");
  });
});
