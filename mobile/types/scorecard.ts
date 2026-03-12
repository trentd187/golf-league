// types/scorecard.ts
// TypeScript interfaces for the GET /api/v1/rounds/:roundId/scorecard response.
// These mirror the Go ScorecardResponse struct in handlers/scores.go.

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

export interface ScorecardPlayer {
  round_player_id: string;
  user_id: string;
  display_name: string;
  course_handicap: number | null;
  scores: ScorecardScore[];
  // Null when fewer holes have been scored than hole_count — prevents showing partial totals.
  total_gross: number | null;
  total_net: number | null;
}

export interface ScorecardGroup {
  group_id: string;
  group_number: number;
  players: ScorecardPlayer[];
}

export interface Scorecard {
  round_id: string;
  round_name: string;
  status: string;
  hole_count: number;
  requires_handicap: boolean;
  scoring_format: string;
  // is_organizer is true when the requesting user is an organizer of this round's event.
  // The mobile client uses this to show/hide the "End Round" button.
  is_organizer: boolean;
  // Hole data from the round's default tee. Empty array when no tee data has been entered yet.
  holes: ScorecardHole[];
  groups: ScorecardGroup[];
}
