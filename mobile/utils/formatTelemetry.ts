// utils/formatTelemetry.ts
// Observability for the client-side team-format derivations (Las Vegas, Best Ball).
// All of that math runs entirely on-device (utils/vegas.ts, utils/bestBall.ts) with
// no server trace, so before this a bug in the derivation surfaced only as a generic
// render crash with no format context, and a correctly-computed result left no signal
// at all. The SRE sweep flagged both as visibility gaps — every new format shipped
// with zero instrumentation.
//
// The two helpers sit at the *screen/tab* boundary, never inside the pure derivations
// (those run in render loops; instrumenting them would flood breadcrumbs and couple
// the tested math to Sentry). Sentry is imported directly — like utils/sentry.ts, this
// module is unit-tested against the manual @sentry/react-native mock.

import * as Sentry from "@sentry/react-native";

export type ScoringFormat = "las_vegas" | "best_ball";

// FormatDerivationContext identifies which derivation ran, for error tags.
export interface FormatDerivationContext {
  format: ScoringFormat;
  derivation: string; // e.g. "round_matches", "event_tally", "live_match"
  roundId?: string;
}

// deriveFormatMatches runs a client-side format derivation under a guard. On success
// it returns the result untouched (no overhead beyond the call). On a thrown error it
// captures a tagged Sentry Issue — turning a previously-silent on-device math bug into
// an actionable, format-attributed Issue — and returns `fallback` so the tab degrades
// to its empty state instead of white-screening the whole round.
export function deriveFormatMatches<T>(
  ctx: FormatDerivationContext,
  compute: () => T,
  fallback: T,
): T {
  try {
    return compute();
  } catch (err) {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: {
        error_source: "format_derivation",
        scoring_format: ctx.format,
        format_derivation: ctx.derivation,
      },
      extra: { roundId: ctx.roundId },
    });
    return fallback;
  }
}

// FormatMatchSummary is the compact, PII-free shape logged when a match set settles.
export interface FormatMatchSummary {
  format: ScoringFormat;
  roundId: string;
  groupCount: number; // matches/standings derived
  completeCount: number; // how many are fully scored
}

// logFormatSummary emits one telemetry line (Sentry Logs — searchable, no Issues
// quota) describing a settled team-format result. Callers fire it at a deliberate
// boundary — when the completion signature changes — not on every render, so the
// signal stays clean. This is the "computed-result telemetry" the formats lacked.
export function logFormatSummary(summary: FormatMatchSummary): void {
  Sentry.logger.info("format.match_summary", {
    scoring_format: summary.format,
    round_id: summary.roundId,
    group_count: summary.groupCount,
    complete_count: summary.completeCount,
  });
}
