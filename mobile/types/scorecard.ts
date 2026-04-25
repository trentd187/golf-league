// types/scorecard.ts
// TypeScript interfaces for the GET /api/v1/rounds/:roundId/scorecard response
// and the PUT /hole-stats request body.
// These mirror the Go ScorecardResponse and UpsertHoleStatsRequest structs in handlers/scores.go.

export interface ScorecardHole {
  hole_number: number;
  par: number;
  stroke_index: number;
  yardage: number | null;
}

export interface ScorecardScore {
  hole_number: number;
  gross_score: number;
  net_score: number;
}

// ScorecardHoleStat holds the advanced per-hole stats returned for each player on the scorecard.
export interface ScorecardHoleStat {
  hole_number: number;
  gir: "hit" | "miss" | "na" | null;
  gir_miss_direction: "short" | "left" | "right" | "long" | null;
  fir: boolean | null;
  fir_miss_direction: "short" | "left" | "right" | "long" | null;
  putts: number | null;
  first_putt_distance: number | null; // feet
  putt_distance_made: number | null;  // feet
  approach_yds: number | null;        // yards; optional — most users will not track this
}

export interface ScorecardPlayer {
  round_player_id: string;
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  course_handicap: number | null;
  scores: ScorecardScore[];
  hole_stats: ScorecardHoleStat[];
  // Null when fewer holes have been scored than hole_count — prevents showing partial totals.
  total_gross: number | null;
  total_net: number | null;
}

export interface ScorecardGroup {
  group_id: string;
  group_number: number;
  players: ScorecardPlayer[];
}

// StatRow: one rank group inside a stat category card (may contain multiple tied players).
export interface StatRow {
  rank: string;
  names: string[];
  value: number;
}

// StatSummary: one category card for the Stats view — holds up to 3 ranked rows.
export interface StatSummary {
  category: string;
  unit: string;
  top3: StatRow[];
}

export interface Scorecard {
  round_id: string;
  round_name: string;
  status: string;
  hole_count: number;
  requires_handicap: boolean;
  scoring_format: string;
  // caller_user_id is the database UUID of the requesting user. Clerk's user.id
  // is a different format, so the server returns the DB UUID here to allow the
  // client to reliably identify its own player entry in the groups list.
  caller_user_id: string;
  // is_organizer is true when the requesting user is an organizer of this round's event.
  // The mobile client uses this to show/hide the "End Round" button.
  is_organizer: boolean;
  // nine_hole_selection is "front" (holes 1–9), "back" (holes 10–18), or null (full round).
  // When set, hole_count is 9 and holes contains only the selected half.
  nine_hole_selection: "front" | "back" | null;
  // Hole data from the round's default tee. Empty array when no tee data has been entered yet.
  holes: ScorecardHole[];
  groups: ScorecardGroup[];
}
