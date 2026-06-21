// utils/saveReconcile.ts
// Reconciles a *failed* scorecard save against authoritative server state — the
// deeper half of the cellular "phantom save" fix.
//
// Background: on cellular the score PUT can commit server-side while the response
// is lost on the last-mile hop. savePut then exhausts its retries and the client
// shows a save error even though the data is safely stored (PUT .../scores is an
// idempotent upsert, so every retry wrote the same rows — only the ack was lost).
// Client retry/backoff alone (519258d) cannot fix this: there is no response to
// recover. The fix is to *read back*. After retries exhaust with a transport
// failure, GET the scorecard and check whether the server already holds exactly
// the values we tried to write. If so the save truly succeeded and the false
// error is suppressed; otherwise it is a real failure and surfaces as before.
//
// Pure + injectable so it is unit-tested while the calling screen
// (app/scorecard/[roundId].tsx) stays coverage-excluded — the extract-first rule.

import type { Scorecard, ScorecardHoleStat } from "@/types/scorecard";

// AttemptedScore mirrors the per-hole payload the scorecard screen sends to
// PUT .../scores (hole_number + gross_score). Kept local so this module does not
// depend on the request-body shape from the screen.
export interface AttemptedScore {
  hole_number: number;
  gross_score: number;
}

// extractServerScores collapses a scorecard response into the target player's
// hole_number → gross_score map. Returns an empty map when the player is not
// found (e.g. a stale/partial response), which makes scoresReconciled fail safe:
// a missing player can never satisfy the equality check, so a real failure is
// never masked.
export function extractServerScores(
  scorecard: Scorecard,
  roundPlayerId: string,
): Map<number, number> {
  const result = new Map<number, number>();
  for (const group of scorecard.groups) {
    const player = group.players.find((p) => p.round_player_id === roundPlayerId);
    if (!player) continue;
    for (const score of player.scores) {
      result.set(score.hole_number, score.gross_score);
    }
    break; // a round_player belongs to exactly one group
  }
  return result;
}

// scoresReconciled returns true when every score we attempted to write is already
// present on the server with the same gross value — i.e. the write committed and
// only the response was lost. A missing or differing hole means at least one write
// did not land, so the failure is real and must still surface. An empty attempt
// set reconciles trivially (there was nothing to lose).
export function scoresReconciled(
  attempted: readonly AttemptedScore[],
  serverScores: ReadonlyMap<number, number>,
): boolean {
  return attempted.every((s) => serverScores.get(s.hole_number) === s.gross_score);
}

// HOLE_STAT_FIELDS are the per-hole stat fields compared during reconciliation —
// the full PUT /hole-stats payload minus hole_number, which is the lookup key
// (already matched by extractServerHoleStat). Kept as a typed list so adding a stat
// column to ScorecardHoleStat is a compile error here until it's reconciled too.
const HOLE_STAT_FIELDS: readonly (keyof ScorecardHoleStat)[] = [
  "gir",
  "gir_miss_direction",
  "fir",
  "fir_miss_direction",
  "putts",
  "first_putt_distance",
  "putt_distance_made",
  "approach_yds",
  "tee_shot_club",
  "tee_shot_distance",
];

// extractServerHoleStat pulls the target player's stat row for one hole out of a
// scorecard response, or null when the player or hole is absent (a stale/partial
// response). Null makes holeStatReconciled fail safe — a missing row can never
// satisfy the equality check, so a real failure is never masked.
export function extractServerHoleStat(
  scorecard: Scorecard,
  roundPlayerId: string,
  holeNumber: number,
): ScorecardHoleStat | null {
  for (const group of scorecard.groups) {
    const player = group.players.find((p) => p.round_player_id === roundPlayerId);
    if (!player) continue;
    return player.hole_stats.find((s) => s.hole_number === holeNumber) ?? null;
    // a round_player belongs to exactly one group, so the first match is authoritative
  }
  return null;
}

// holeStatReconciled returns true when the server's stat row for the hole matches
// every field we attempted to write — i.e. the PUT committed and only the response
// was lost. A missing row, or any differing field, means the write did not land and
// the failure must still surface. undefined and null are treated as equal because the
// attempted payload may carry undefined where the server stores SQL NULL (rendered null).
export function holeStatReconciled(
  attempted: ScorecardHoleStat,
  serverStat: ScorecardHoleStat | null,
): boolean {
  if (!serverStat) return false;
  const norm = (v: unknown): unknown => (v === undefined ? null : v);
  return HOLE_STAT_FIELDS.every((f) => norm(attempted[f]) === norm(serverStat[f]));
}
