// __tests__/utils/saveReconcile.test.ts
// Unit tests for the phantom-save read-back reconciliation helpers. These are pure
// functions, so the tests build minimal scorecard fixtures and assert the equality
// logic directly — no network, no mocks.

import {
  extractServerScores,
  scoresReconciled,
  type AttemptedScore,
} from "@/utils/saveReconcile";
import type { Scorecard, ScorecardPlayer } from "@/types/scorecard";

// player builds a minimal ScorecardPlayer with just the fields these helpers read.
function player(roundPlayerId: string, scores: [number, number][]): ScorecardPlayer {
  return {
    round_player_id: roundPlayerId,
    user_id: `u-${roundPlayerId}`,
    display_name: roundPlayerId,
    avatar_url: null,
    course_handicap: null,
    effective_course_handicap: null,
    team_id: null,
    team_name: null,
    scores: scores.map(([hole_number, gross_score]) => ({
      hole_number,
      gross_score,
      net_score: gross_score,
    })),
    hole_stats: [],
    total_gross: null,
    total_net: null,
  };
}

// scorecard wraps players into two groups so extractServerScores must search across them.
function scorecard(...players: ScorecardPlayer[]): Scorecard {
  return {
    round_id: "r1",
    round_name: "Test",
    status: "active",
    hole_count: 18,
    requires_handicap: false,
    scoring_format: "stroke_play",
    vegas_birdie_flip: true,
    vegas_scoring_basis: "gross",
    best_ball_scoring_basis: "gross",
    caller_user_id: "caller",
    is_organizer: false,
    handicap_allowance: null,
    nine_hole_selection: null,
    holes: [],
    groups: [
      { group_id: "g1", group_number: 1, players: players.slice(0, 1) },
      { group_id: "g2", group_number: 2, players: players.slice(1) },
    ],
  };
}

describe("extractServerScores", () => {
  it("returns the target player's hole→gross map across groups", () => {
    const card = scorecard(player("rp1", [[1, 4], [2, 5]]), player("rp2", [[1, 6]]));
    const map = extractServerScores(card, "rp2");
    expect(map.get(1)).toBe(6);
    expect(map.size).toBe(1);
  });

  it("returns an empty map when the player is absent (fails safe)", () => {
    const card = scorecard(player("rp1", [[1, 4]]));
    expect(extractServerScores(card, "missing").size).toBe(0);
  });
});

describe("scoresReconciled", () => {
  const attempted: AttemptedScore[] = [
    { hole_number: 1, gross_score: 4 },
    { hole_number: 2, gross_score: 5 },
  ];

  it("is true when every attempted score matches the server", () => {
    const server = new Map([[1, 4], [2, 5]]);
    expect(scoresReconciled(attempted, server)).toBe(true);
  });

  it("is false when a hole is missing on the server (write did not land)", () => {
    const server = new Map([[1, 4]]);
    expect(scoresReconciled(attempted, server)).toBe(false);
  });

  it("is false when a hole differs (partial / stale write)", () => {
    const server = new Map([[1, 4], [2, 7]]);
    expect(scoresReconciled(attempted, server)).toBe(false);
  });

  it("is true for an empty attempt set (nothing could have been lost)", () => {
    expect(scoresReconciled([], new Map())).toBe(true);
  });

  it("ignores extra server scores not in the attempt (other holes/players)", () => {
    const server = new Map([[1, 4], [2, 5], [3, 6]]);
    expect(scoresReconciled(attempted, server)).toBe(true);
  });
});
