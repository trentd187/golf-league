// __tests__/utils/saveReconcile.test.ts
// Unit tests for the phantom-save read-back reconciliation helpers. These are pure
// functions, so the tests build minimal scorecard fixtures and assert the equality
// logic directly — no network, no mocks.

import {
  extractServerScores,
  scoresReconciled,
  extractServerHoleStat,
  holeStatReconciled,
  type AttemptedScore,
} from "@/utils/saveReconcile";
import type { Scorecard, ScorecardHoleStat, ScorecardPlayer } from "@/types/scorecard";

// fullStat builds a ScorecardHoleStat with every field populated, for stat reconcile tests.
function fullStat(hole_number: number, over: Partial<ScorecardHoleStat> = {}): ScorecardHoleStat {
  return {
    hole_number,
    gir: "hit",
    gir_miss_direction: null,
    fir: true,
    fir_miss_direction: null,
    fir_ob: null,
    gir_ob: null,
    putts: 2,
    first_putt_distance: 18,
    putt_distance_made: 4,
    approach_yds: 150,
    tee_shot_club: "DR",
    tee_shot_distance: 270,
    ...over,
  };
}

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

// playerWithStats builds a player carrying hole_stats so the stat helpers have data to read.
function playerWithStats(roundPlayerId: string, stats: ScorecardHoleStat[]): ScorecardPlayer {
  return { ...player(roundPlayerId, []), hole_stats: stats };
}

describe("extractServerHoleStat", () => {
  it("returns the target player's stat for the hole across groups", () => {
    const card = scorecard(
      playerWithStats("rp1", [fullStat(1)]),
      playerWithStats("rp2", [fullStat(1, { putts: 3 }), fullStat(2)]),
    );
    expect(extractServerHoleStat(card, "rp2", 1)?.putts).toBe(3);
  });

  it("returns null when the player is absent (fails safe)", () => {
    const card = scorecard(playerWithStats("rp1", [fullStat(1)]));
    expect(extractServerHoleStat(card, "missing", 1)).toBeNull();
  });

  it("returns null when the hole has no stat row yet", () => {
    const card = scorecard(playerWithStats("rp1", [fullStat(1)]));
    expect(extractServerHoleStat(card, "rp1", 2)).toBeNull();
  });
});

describe("holeStatReconciled", () => {
  it("is true when every attempted field matches the server row", () => {
    expect(holeStatReconciled(fullStat(5), fullStat(5))).toBe(true);
  });

  it("is false when the server row is missing (write did not land)", () => {
    expect(holeStatReconciled(fullStat(5), null)).toBe(false);
  });

  it("is false when any field differs (partial / stale write)", () => {
    expect(holeStatReconciled(fullStat(5, { putts: 2 }), fullStat(5, { putts: 3 }))).toBe(false);
  });

  it("treats attempted undefined as server null (SQL NULL round-trips as null)", () => {
    // The PUT payload may omit a field as undefined; the server stores and returns null.
    const attempted = fullStat(5, { approach_yds: undefined as unknown as number });
    expect(holeStatReconciled(attempted, fullStat(5, { approach_yds: null }))).toBe(true);
  });
});
