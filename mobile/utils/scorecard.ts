// utils/scorecard.ts
// Pure calculation helpers for the scorecard auto-fill logic.
// Kept separate so they can be unit-tested without rendering the component.

import type { ScorecardPlayer, TeeShotClub } from "@/types/scorecard";

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

// moveStatUp moves `key` one position earlier in `order`. Returns a new array (does
// not mutate the input). Returns the original reference unchanged if key is first or
// not found — callers can safely call mutate even on boundary presses.
export function moveStatUp(order: string[], key: string): string[] {
  const idx = order.indexOf(key);
  if (idx <= 0) return order;
  const next = [...order];
  [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
  return next;
}

// moveStatDown moves `key` one position later in `order`. Returns a new array (does
// not mutate the input). Returns the original reference unchanged if key is last or
// not found.
export function moveStatDown(order: string[], key: string): string[] {
  const idx = order.indexOf(key);
  if (idx === -1 || idx === order.length - 1) return order;
  const next = [...order];
  [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
  return next;
}

// numericStatFocusNext returns what the return-key should focus when the user
// presses Enter on a numeric stat TextInput at position numIdx.
//   - Returns the next stat index when one exists.
//   - Returns "score" when this is the last stat and score_position is "last"
//     (score input comes after the stats).
//   - Returns null to dismiss the keyboard (last stat, score comes first).
export function numericStatFocusNext(
  numIdx: number,
  totalNumericStats: number,
  scorePosition: "first" | "last",
): number | "score" | null {
  if (numIdx < totalNumericStats - 1) return numIdx + 1;
  return scorePosition === "last" ? "score" : null;
}

// scoreFocusNext returns the index of the first stat input to focus when the user
// presses Enter on the score TextInput, or null to dismiss the keyboard.
// Focus only chains forward when score_position is "first" and numeric stats exist.
export function scoreFocusNext(
  scorePosition: "first" | "last",
  totalNumericStats: number,
): number | null {
  return scorePosition === "first" && totalNumericStats > 0 ? 0 : null;
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

// ─── Local editable state + server merge ────────────────────────────────────────
// The scorecard screen holds scores/stats/handicaps in local React state so the
// TextInputs stay editable and blank-able. These types and the init builders below are
// shared with the live-merge helpers so the "initialize from server" and "re-sync from
// server" paths produce identical shapes (a prerequisite for the 3-way merge's equality
// checks to converge). Logic lives here (not the screen) so it is unit-tested.

// LocalScores maps round_player_id → hole_number → gross score string input.
// String rather than number so empty input fields stay blank.
export type LocalScores = Record<string, Record<number, string>>;

// LocalHandicaps maps round_player_id → handicap string input.
export type LocalHandicaps = Record<string, string>;

// HoleStatEntry holds the editable state for one hole's advanced stats.
// Putts and distances use strings so TextInput fields can be blank.
export type HoleStatEntry = {
  gir: string | null;                 // "hit" | "miss" | "na" | null
  gir_miss_direction: string | null;  // "short" | "left" | "right" | "long" | null
  fir: boolean | null;
  fir_miss_direction: string | null;
  // fir_ob/gir_ob: additive out-of-bounds flags for the tee shot and approach.
  // Set independently of the directional pills (a shot can be both a direction and OB).
  fir_ob: boolean | null;
  gir_ob: boolean | null;
  putts: string;
  first_putt_distance: string; // feet
  putt_distance_made: string;  // feet
  approach_yds: string;        // yards; optional
  tee_shot_club: TeeShotClub | null;
  tee_shot_distance: string;   // yards
};

// NumericStatField is the subset of HoleStatEntry keys that are string fields
// rendered as TextInput number-pads in the stats section.
export type NumericStatField = "putts" | "first_putt_distance" | "putt_distance_made" | "approach_yds" | "tee_shot_distance";

// LocalStats maps round_player_id → hole_number → HoleStatEntry.
export type LocalStats = Record<string, Record<number, HoleStatEntry>>;

// initScores builds the initial LocalScores state from existing server scores.
export function initScores(players: ScorecardPlayer[]): LocalScores {
  const out: LocalScores = {};
  for (const p of players) {
    out[p.round_player_id] = {};
    for (const s of p.scores) {
      out[p.round_player_id][s.hole_number] = String(s.gross_score);
    }
  }
  return out;
}

// initHandicaps builds the initial LocalHandicaps state from existing server data.
export function initHandicaps(players: ScorecardPlayer[]): LocalHandicaps {
  const out: LocalHandicaps = {};
  for (const p of players) {
    out[p.round_player_id] = p.course_handicap != null ? String(p.course_handicap) : "";
  }
  return out;
}

// initStats builds the initial LocalStats state from server-loaded hole_stats.
export function initStats(players: ScorecardPlayer[]): LocalStats {
  const out: LocalStats = {};
  for (const p of players) {
    out[p.round_player_id] = {};
    for (const s of p.hole_stats) {
      out[p.round_player_id][s.hole_number] = {
        gir:                 s.gir,
        gir_miss_direction:  s.gir_miss_direction,
        fir:                 s.fir,
        fir_miss_direction:  s.fir_miss_direction,
        fir_ob:              s.fir_ob ?? null,
        gir_ob:              s.gir_ob ?? null,
        putts:               s.putts != null ? String(s.putts) : "",
        first_putt_distance: s.first_putt_distance != null ? String(s.first_putt_distance) : "",
        putt_distance_made:  s.putt_distance_made != null ? String(s.putt_distance_made) : "",
        approach_yds:        s.approach_yds != null ? String(s.approach_yds) : "",
        tee_shot_club:       s.tee_shot_club ?? null,
        tee_shot_distance:   s.tee_shot_distance != null ? String(s.tee_shot_distance) : "",
      };
    }
  }
  return out;
}

// holeStatEntryEquals deep-compares two stat entries field-by-field. Every field is a
// primitive (string/boolean/null), so === is sufficient — no nested objects.
export function holeStatEntryEquals(a: HoleStatEntry, b: HoleStatEntry): boolean {
  return (
    a.gir === b.gir &&
    a.gir_miss_direction === b.gir_miss_direction &&
    a.fir === b.fir &&
    a.fir_miss_direction === b.fir_miss_direction &&
    a.fir_ob === b.fir_ob &&
    a.gir_ob === b.gir_ob &&
    a.putts === b.putts &&
    a.first_putt_distance === b.first_putt_distance &&
    a.putt_distance_made === b.putt_distance_made &&
    a.approach_yds === b.approach_yds &&
    a.tee_shot_club === b.tee_shot_club &&
    a.tee_shot_distance === b.tee_shot_distance
  );
}

// merge3 resolves one cell via a 3-way merge of base (the previous server snapshot),
// local (current on-screen value, possibly an unsaved edit), and incoming (the fresh
// server snapshot):
//   - local unchanged from base → take incoming  (this is how a peer's update flows in)
//   - local diverged from base  → keep local until the server echoes it back (incoming
//     equals local), at which point the cell graduates back to server control.
// Single-writer-per-cell in practice means a true 3-way conflict can't arise; keeping
// local on the residual case is the safe choice (it converges once our save propagates).
function merge3<T>(
  base: T | undefined,
  local: T | undefined,
  incoming: T | undefined,
  eq: (x: T | undefined, y: T | undefined) => boolean,
): T | undefined {
  if (eq(local, base)) return incoming;
  if (eq(incoming, local)) return incoming;
  return local;
}

const strEq = (x: string | undefined, y: string | undefined): boolean => x === y;

// statEq adapts holeStatEntryEquals to merge3's (T|undefined) signature.
const statEq = (x: HoleStatEntry | undefined, y: HoleStatEntry | undefined): boolean =>
  x === undefined || y === undefined ? x === y : holeStatEntryEquals(x, y);

// unionKeys returns the de-duplicated key set across two records.
function unionKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])];
}

// threeWayMergeScores merges a fresh server scores snapshot (`incoming`) into the current
// on-screen `local` state, using `base` (the last server snapshot the screen synced) to
// tell apart "peer changed this cell" from "I have an unsaved edit here". See merge3.
export function threeWayMergeScores(
  base: LocalScores,
  local: LocalScores,
  incoming: LocalScores,
): LocalScores {
  const out: LocalScores = {};
  for (const pid of unionKeys(local, incoming)) {
    const b = base[pid] ?? {};
    const l = local[pid] ?? {};
    const i = incoming[pid] ?? {};
    const merged: Record<number, string> = {};
    for (const holeStr of unionKeys(l, i)) {
      const h = Number(holeStr);
      const v = merge3<string>(b[h], l[h], i[h], strEq);
      // Omit blank cells so the state matches initScores (which skips unscored holes);
      // a missing key and "" render identically.
      if (v !== undefined && v !== "") merged[h] = v;
    }
    out[pid] = merged;
  }
  return out;
}

// threeWayMergeStats is the per-hole-stat analogue of threeWayMergeScores.
export function threeWayMergeStats(
  base: LocalStats,
  local: LocalStats,
  incoming: LocalStats,
): LocalStats {
  const out: LocalStats = {};
  for (const pid of unionKeys(local, incoming)) {
    const b = base[pid] ?? {};
    const l = local[pid] ?? {};
    const i = incoming[pid] ?? {};
    const merged: Record<number, HoleStatEntry> = {};
    for (const holeStr of unionKeys(l, i)) {
      const h = Number(holeStr);
      const v = merge3<HoleStatEntry>(b[h], l[h], i[h], statEq);
      if (v !== undefined) merged[h] = v;
    }
    out[pid] = merged;
  }
  return out;
}

// threeWayMergeHandicaps merges the flat per-player handicap map. Unlike scores, "" is a
// meaningful value (no handicap entered), so every player keeps a key.
export function threeWayMergeHandicaps(
  base: LocalHandicaps,
  local: LocalHandicaps,
  incoming: LocalHandicaps,
): LocalHandicaps {
  const out: LocalHandicaps = {};
  for (const pid of unionKeys(local, incoming)) {
    out[pid] = merge3<string>(base[pid], local[pid], incoming[pid], strEq) ?? "";
  }
  return out;
}
