// __tests__/utils/formatTelemetry.test.ts
// Unit tests for the team-format observability helpers. @sentry/react-native is the
// manual mock, so we assert on captureException / logger.info without the native SDK.

import * as Sentry from "@sentry/react-native";
import {
  deriveFormatMatches,
  logFormatSummary,
} from "@/utils/formatTelemetry";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("deriveFormatMatches", () => {
  it("returns the computed result and reports nothing on success", () => {
    const result = deriveFormatMatches(
      { format: "las_vegas", derivation: "round_matches" },
      () => [1, 2, 3],
      [],
    );
    expect(result).toEqual([1, 2, 3]);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("captures a format-tagged Issue and returns the fallback when the derivation throws", () => {
    const fallback: number[] = [];
    const result = deriveFormatMatches<number[]>(
      { format: "best_ball", derivation: "round_matches", roundId: "r1" },
      () => {
        throw new Error("bad team partition");
      },
      fallback,
    );
    expect(result).toBe(fallback); // graceful degrade — tab shows empty state
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = (Sentry.captureException as jest.Mock).mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("bad team partition");
    expect(ctx.tags).toMatchObject({
      error_source: "format_derivation",
      scoring_format: "best_ball",
      format_derivation: "round_matches",
    });
    expect(ctx.extra.roundId).toBe("r1");
  });

  it("wraps a non-Error throw into an Error before capturing", () => {
    deriveFormatMatches(
      { format: "las_vegas", derivation: "live_match" },
      () => {
        throw "string boom";
      },
      null,
    );
    const [err] = (Sentry.captureException as jest.Mock).mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("string boom");
  });
});

describe("logFormatSummary", () => {
  it("emits a single info log with the compact match summary", () => {
    logFormatSummary({
      format: "las_vegas",
      roundId: "r1",
      groupCount: 2,
      completeCount: 1,
    });
    expect(Sentry.logger.info).toHaveBeenCalledTimes(1);
    expect(Sentry.logger.info).toHaveBeenCalledWith("format.match_summary", {
      scoring_format: "las_vegas",
      round_id: "r1",
      group_count: 2,
      complete_count: 1,
    });
  });
});
