// types/scorecard.ts
// TypeScript interfaces for the GET /api/v1/rounds/:roundId/scorecard response,
// the PUT /hole-stats request body, and the GET/PATCH scorecard-settings endpoints.
// These mirror the Go structs in handlers/scores.go and handlers/users.go.

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

// TeeShotClub is the allowed set for the tee_shot_club enum field.
export type TeeShotClub = "DR" | "3W" | "5W" | "7W" | "DI" | "3H";
export const TEE_SHOT_CLUBS: TeeShotClub[] = ["DR", "3W", "5W", "7W", "DI", "3H"];

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
  tee_shot_club: TeeShotClub | null;
  tee_shot_distance: number | null;   // yards
}

// ScorecardSettings stores per-user toggles for which supplemental stats appear
// on the active scorecard, their display order, and where the score entry appears.
// Mirrors GET/PATCH /api/v1/users/me/scorecard-settings.
// Existing stats default true (preserving current behaviour); new stats default false.
export interface ScorecardSettings {
  fir_enabled:                 boolean;
  gir_enabled:                 boolean;
  putts_enabled:               boolean;
  first_putt_distance_enabled: boolean;
  putt_distance_made_enabled:  boolean;
  approach_yds_enabled:        boolean;
  tee_shot_club_enabled:       boolean;
  tee_shot_distance_enabled:   boolean;
  // stat_order controls the sequence stats appear on the scorecard.
  stat_order:                  string[];
  // score_position controls whether gross score entry appears before or after stats.
  score_position:              "first" | "last";
  // show_group_on_scorecard controls whether other players in the group are shown.
  // When false, the scorecard always shows individual view for the current user only.
  show_group_on_scorecard:     boolean;
}

// DEFAULT_SCORECARD_SETTINGS matches the server-side column defaults so the UI
// is stable before the settings query resolves.
export const DEFAULT_SCORECARD_SETTINGS: ScorecardSettings = {
  fir_enabled:                 true,
  gir_enabled:                 true,
  putts_enabled:               true,
  first_putt_distance_enabled: true,
  putt_distance_made_enabled:  true,
  approach_yds_enabled:        true,
  tee_shot_club_enabled:       false,
  tee_shot_distance_enabled:   false,
  stat_order:                  ["fir", "gir", "putts", "first_putt_distance", "putt_distance_made", "approach_yds", "tee_shot_club", "tee_shot_distance"],
  score_position:              "last",
  show_group_on_scorecard:     true,
};

export interface ScorecardPlayer {
  round_player_id: string;
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  course_handicap: number | null;
  // effective_course_handicap is course_handicap after applying the event's handicap allowance.
  // Equal to course_handicap when no allowance is set. Null when course_handicap is null.
  effective_course_handicap: number | null;
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
  // caller_user_id is the database UUID of the requesting user. The Supabase auth UUID
  // differs from the DB UUID, so the server returns the DB UUID here to allow the
  // client to reliably identify its own player entry in the groups list.
  caller_user_id: string;
  // is_organizer is true when the requesting user is an organizer of this round's event.
  // The mobile client uses this to show/hide the "End Round" button.
  is_organizer: boolean;
  // handicap_allowance is the event-level percentage applied to each player's course handicap
  // (e.g. 90 = 90%). Null means full handicap (no allowance set).
  handicap_allowance: number | null;
  // nine_hole_selection is "front" (holes 1–9), "back" (holes 10–18), or null (full round).
  // When set, hole_count is 9 and holes contains only the selected half.
  nine_hole_selection: "front" | "back" | null;
  // Hole data from the round's default tee. Empty array when no tee data has been entered yet.
  holes: ScorecardHole[];
  groups: ScorecardGroup[];
}

// UserHandicapStats is the slice of GET /api/v1/users/:userId/stats that the
// mobile app consumes. Both fields are null when fewer than 3 rounds have tee data.
export interface UserHandicapStats {
  handicap_index: number | null;
  anti_handicap:  number | null;
}
