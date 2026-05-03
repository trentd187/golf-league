// utils/scorecard.ts
// Pure calculation helpers for the scorecard auto-fill logic.
// Kept separate so they can be unit-tested without rendering the component.

// girScoreFromPutts computes the expected gross score when a player hit the green
// in regulation (GIR). GIR means reaching in par - 2 shots, so total = (par - 2) + putts.
export function girScoreFromPutts(par: number, putts: number): number {
  return par - 2 + putts;
}

// girPuttsHint returns an auto-seeded putts value when GIR is first tapped "hit"
// and the score field is already filled in. Returns null when no hint applies.
//   birdie (gross = par - 1) → 1 putt
//   par    (gross = par)     → 2 putts
//   any other score          → null (don't guess)
export function girPuttsHint(par: number, gross: number): string | null {
  if (gross === par - 1) return "1";
  if (gross === par)     return "2";
  return null;
}

// holeRangeTotal sums par and gross scores for holes within [fromHole, toHole].
// Used to compute OUT (front 9) and IN (back 9) subtotals in the group scorecard.
// Returns null for score when no holes in the range have a valid gross entered.
export function holeRangeTotal(
  holeRows: { hole_number: number; par: number }[],
  playerScores: Record<number, string>,
  fromHole: number,
  toHole: number,
): { par: number; score: number | null } {
  let parSum = 0;
  let scoreSum = 0;
  let scoredCount = 0;
  for (const hole of holeRows) {
    if (hole.hole_number < fromHole || hole.hole_number > toHole) continue;
    parSum += hole.par;
    const g = parseInt(playerScores[hole.hole_number] ?? "", 10);
    if (!isNaN(g) && g >= 1) { scoreSum += g; scoredCount++; }
  }
  return { par: parSum, score: scoredCount > 0 ? scoreSum : null };
}

// puttDistanceMirror returns the extra stat field to update when putts = 1.
// When a player holes a 1-putt, first_putt_distance and putt_distance_made
// are the same value — whichever field the user edits should be mirrored to the other.
// Returns an empty object when mirroring does not apply.
export function puttDistanceMirror(
  field: "first_putt_distance" | "putt_distance_made" | string,
  putts: string,
  value: string,
): Record<string, string> {
  if (putts !== "1") return {};
  if (field === "putt_distance_made")  return { first_putt_distance: value };
  if (field === "first_putt_distance") return { putt_distance_made: value };
  return {};
}
