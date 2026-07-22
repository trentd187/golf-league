// utils/handicap.ts
// Pure handicap-stroke allocation shared by every team format that needs net
// scores derived client-side (Las Vegas, Best Ball, …). Kept React-free so it can
// be unit-tested in isolation and reused without pulling in any format's helpers.
// Mirrors the backend allocation so client-computed net matches the server exactly.

import type { ScorecardHole } from "@/types/scorecard";

// normalizeStrokeIndexes ranks holes by ascending stroke_index (1 = hardest) so
// handicap strokes allocate correctly even when playing a 9-hole subset. Mirrors
// the backend NormalizeStrokeIndexes so client-computed net matches the server.
export function normalizeStrokeIndexes(holes: ScorecardHole[]): Record<number, number> {
  const sorted = [...holes].sort((a, b) => a.stroke_index - b.stroke_index);
  const map: Record<number, number> = {};
  sorted.forEach((h, i) => {
    map[h.hole_number] = i + 1;
  });
  return map;
}

// holeHandicapStrokes returns the strokes a player receives (positive) or gives
// back (negative) on a hole given their effective handicap, the hole's normalized
// stroke-index rank, and the hole count. Net is always `gross - strokes`, so a
// negative return (plus handicap) raises the player's net on that hole.
// Mirrors the backend HandicapStrokes allocation rule.
//
// A POSITIVE handicap receives strokes on the hardest holes first (normalizedSI 1 up).
// A PLUS handicap (negative, better than scratch) gives strokes back starting at the
// EASIEST hole (highest normalizedSI) and working down — the USGA convention, the
// exact mirror of receiving. A negative value here means "add a stroke to gross".
export function holeHandicapStrokes(effHandicap: number, normalizedSI: number, holeCount: number): number {
  if (effHandicap === 0 || normalizedSI <= 0 || holeCount <= 0) return 0;
  if (effHandicap > 0) {
    const full = Math.floor(effHandicap / holeCount);
    const remainder = effHandicap % holeCount;
    return full + (normalizedSI <= remainder ? 1 : 0);
  }
  // Plus handicap: give `give` strokes back, allocated from the easiest hole down.
  const give = -effHandicap;
  const full = Math.floor(give / holeCount);
  const remainder = give % holeCount;
  const given = full + (normalizedSI > holeCount - remainder ? 1 : 0);
  return given === 0 ? 0 : -given; // avoid returning -0 for holes with no given stroke
}

// parseCourseHandicapInput converts a raw text input to the stored course_handicap
// value, using golf notation: a leading "+" marks a PLUS handicap (better than
// scratch) and is stored as a negative (e.g. "+2" → -2); plain digits are a regular
// handicap ("12" → 12); "0" is scratch. Empty/whitespace or anything else (a bare
// "-", a decimal, stray characters) → null so a typo never blocks the save — the
// caller shows an error and the organizer can correct it.
export function parseCourseHandicapInput(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\+?\d+$/.test(trimmed)) return null;
  const digits = Number(trimmed.replace("+", ""));
  if (!Number.isInteger(digits)) return null;
  if (digits === 0) return 0; // avoid producing -0 for "+0"
  // A leading "+" means a plus handicap, stored as negative.
  return trimmed.startsWith("+") ? -digits : digits;
}

// formatCourseHandicap renders a stored course_handicap for display in golf notation:
// a plus handicap (negative) shows with a "+" prefix (-2 → "+2"), scratch is "0",
// and a regular handicap is its plain number (12 → "12").
export function formatCourseHandicap(stored: number): string {
  if (stored < 0) return `+${-stored}`;
  return String(stored);
}

// formatCourseHandicapWithAllowance renders a player's course handicap for the C.H.
// header, appending the allowance-adjusted effective handicap when an allowance is
// active and actually changes the value (e.g. "+2 → +1"). Otherwise just the plain
// handicap ("+2", "12"). Empty string when the handicap is unset. This is the header
// home for the raw→effective conversion that used to clutter every per-hole box.
export function formatCourseHandicapWithAllowance(
  courseHandicap: number | null | undefined,
  effective: number | null | undefined,
  allowanceActive: boolean,
): string {
  if (courseHandicap == null) return "";
  const base = formatCourseHandicap(courseHandicap);
  if (allowanceActive && effective != null && effective !== courseHandicap) {
    return `${base} → ${formatCourseHandicap(effective)}`;
  }
  return base;
}

// formatHoleStrokeAdjustment renders a hole's handicap strokes as the signed change
// applied to gross to get net (i.e. `-strokes`): a received stroke lowers the score
// ("−1"), a plus-handicap given stroke raises it ("+1"). Uses a true minus sign (−)
// for clarity. Callers only render this when strokes !== 0.
export function formatHoleStrokeAdjustment(strokes: number): string {
  if (strokes > 0) return `−${strokes}`; // received: subtracted from gross
  return `+${-strokes}`; // given (plus handicap): added to gross
}
