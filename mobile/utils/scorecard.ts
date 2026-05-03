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
