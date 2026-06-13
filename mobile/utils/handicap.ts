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

// holeHandicapStrokes returns the strokes a player receives on a hole given their
// effective handicap, the hole's normalized stroke-index rank, and the hole count.
// Mirrors the backend HandicapStrokes allocation rule.
export function holeHandicapStrokes(effHandicap: number, normalizedSI: number, holeCount: number): number {
  if (effHandicap <= 0 || normalizedSI <= 0 || holeCount <= 0) return 0;
  const full = Math.floor(effHandicap / holeCount);
  const remainder = effHandicap % holeCount;
  return full + (normalizedSI <= remainder ? 1 : 0);
}
