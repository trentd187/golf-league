// __tests__/utils/vegas.test.ts
// Unit tests for the pure Las Vegas helpers in utils/vegas.ts. Covers the combine
// + flip + running-total arithmetic and the round/event model builders, including
// every edge case (cap at 9, ties, incompletes, missing teams, gross vs net).

import {
  clampForCombine,
  combineTeamNumber,
  teamHasBirdie,
  flipTeamNumber,
  holeDifferential,
  buildRoundMatch,
  buildRoundMatches,
  buildEventTally,
  normalizeStrokeIndexes,
  holeHandicapStrokes,
  buildLiveVegasMatch,
  type VegasHoleEntry,
} from "@/utils/vegas";
import type { Scorecard, ScorecardGroup, ScorecardHole, ScorecardPlayer } from "@/types/scorecard";

// ─── Factories ──────────────────────────────────────────────────────────────────

type ScoreSpec = { h: number; g: number; n?: number };

function mkPlayer(
  rpId: string,
  userId: string,
  name: string,
  teamId: string | null,
  teamName: string | null,
  scores: ScoreSpec[],
): ScorecardPlayer {
  return {
    round_player_id: rpId,
    user_id: userId,
    display_name: name,
    avatar_url: null,
    course_handicap: null,
    effective_course_handicap: null,
    team_id: teamId,
    team_name: teamName,
    scores: scores.map((s) => ({ hole_number: s.h, gross_score: s.g, net_score: s.n ?? s.g })),
    hole_stats: [],
    total_gross: null,
    total_net: null,
  };
}

function mkHoles(count: number, par = 4): ScorecardHole[] {
  return Array.from({ length: count }, (_, i) => ({
    hole_number: i + 1,
    par,
    stroke_index: i + 1,
    yardage: null,
  }));
}

function mkScorecard(opts: {
  holes: ScorecardHole[];
  groups: ScorecardGroup[];
  flip?: boolean;
  basis?: string;
  format?: string;
  roundId?: string;
  roundName?: string;
}): Scorecard {
  return {
    round_id: opts.roundId ?? "round-1",
    round_name: opts.roundName ?? "Round 1",
    status: "active",
    hole_count: opts.holes.length,
    requires_handicap: false,
    scoring_format: opts.format ?? "las_vegas",
    vegas_birdie_flip: opts.flip ?? true,
    vegas_scoring_basis: opts.basis ?? "gross",
    best_ball_scoring_basis: "gross",
    caller_user_id: "u-a1",
    is_organizer: false,
    handicap_allowance: null,
    nine_hole_selection: null,
    holes: opts.holes,
    groups: opts.groups,
  };
}

// entry builds a VegasHoleEntry for holeDifferential tests.
const entry = (value: number | null, par: number | null = 4): VegasHoleEntry => ({ value, par });

// ─── clampForCombine ──────────────────────────────────────────────────────────

describe("clampForCombine", () => {
  it("leaves single-digit scores unchanged", () => {
    expect(clampForCombine(4)).toBe(4);
    expect(clampForCombine(9)).toBe(9);
  });
  it("caps 10+ at 9", () => {
    expect(clampForCombine(10)).toBe(9);
    expect(clampForCombine(12)).toBe(9);
  });
});

// ─── combineTeamNumber ────────────────────────────────────────────────────────

describe("combineTeamNumber", () => {
  it("puts the low digit first regardless of order", () => {
    expect(combineTeamNumber(4, 5)).toBe(45);
    expect(combineTeamNumber(5, 4)).toBe(45);
  });
  it("handles equal scores", () => {
    expect(combineTeamNumber(4, 4)).toBe(44);
  });
  it("caps a 10+ score at 9 before combining", () => {
    expect(combineTeamNumber(6, 11)).toBe(69);
    expect(combineTeamNumber(10, 12)).toBe(99);
  });
  it("returns null when either score is missing", () => {
    expect(combineTeamNumber(4, null)).toBeNull();
    expect(combineTeamNumber(null, 4)).toBeNull();
    expect(combineTeamNumber(null, null)).toBeNull();
  });
});

// ─── teamHasBirdie ────────────────────────────────────────────────────────────

describe("teamHasBirdie", () => {
  it("is true when any player is under par", () => {
    expect(teamHasBirdie([entry(4), entry(3)])).toBe(true);
  });
  it("is false when no player is under par", () => {
    expect(teamHasBirdie([entry(4), entry(5)])).toBe(false);
  });
  it("ignores entries with missing value or par", () => {
    expect(teamHasBirdie([entry(null), entry(3, null)])).toBe(false);
  });
});

// ─── flipTeamNumber ───────────────────────────────────────────────────────────

describe("flipTeamNumber", () => {
  it("swaps to high digit first", () => {
    expect(flipTeamNumber(56)).toBe(65);
    expect(flipTeamNumber(45)).toBe(54);
  });
  it("leaves a palindrome unchanged", () => {
    expect(flipTeamNumber(44)).toBe(44);
  });
});

// ─── holeDifferential ─────────────────────────────────────────────────────────

describe("holeDifferential", () => {
  it("awards points to the lower team number", () => {
    const r = holeDifferential(1, [entry(4), entry(5)], [entry(5), entry(6)], true);
    expect(r.teamANumber).toBe(45);
    expect(r.teamBNumber).toBe(56);
    expect(r.pointsA).toBe(11);
    expect(r.winner).toBe("A");
    expect(r.complete).toBe(true);
  });

  it("flips the opponents' number when a team birdies", () => {
    // Team A birdies (3 < 4) → Team B (5,6 = 56) flips to 65.
    const r = holeDifferential(1, [entry(3), entry(4)], [entry(5), entry(6)], true);
    expect(r.flipAppliedToB).toBe(true);
    expect(r.teamBNumber).toBe(65);
    expect(r.teamANumber).toBe(34);
    expect(r.pointsA).toBe(31);
  });

  it("does not flip when the flip rule is disabled", () => {
    const r = holeDifferential(1, [entry(3), entry(4)], [entry(5), entry(6)], false);
    expect(r.flipAppliedToB).toBe(false);
    expect(r.teamBNumber).toBe(56);
    expect(r.pointsA).toBe(22);
  });

  it("flips both numbers when both teams birdie", () => {
    // A 3,5 = 35 (birdie) → B flips; B 3,6 = 36 (birdie) → A flips.
    const r = holeDifferential(1, [entry(3), entry(5)], [entry(3), entry(6)], true);
    expect(r.flipAppliedToA).toBe(true);
    expect(r.flipAppliedToB).toBe(true);
    expect(r.teamANumber).toBe(53); // flip(35)
    expect(r.teamBNumber).toBe(63); // flip(36)
    expect(r.pointsA).toBe(10);
  });

  it("returns a tie for equal numbers", () => {
    const r = holeDifferential(1, [entry(4), entry(5)], [entry(4), entry(5)], true);
    expect(r.pointsA).toBe(0);
    expect(r.winner).toBe("tie");
  });

  it("is incomplete when a team is missing a score", () => {
    const r = holeDifferential(1, [entry(4), entry(null)], [entry(4), entry(5)], true);
    expect(r.complete).toBe(false);
    expect(r.pointsA).toBe(0);
    expect(r.winner).toBeNull();
    expect(r.teamANumber).toBeNull();
  });

  it("does not flip when par data is missing (birdie undeterminable)", () => {
    const r = holeDifferential(1, [entry(3, null), entry(4, null)], [entry(5, null), entry(6, null)], true);
    expect(r.flipAppliedToB).toBe(false);
    expect(r.teamBNumber).toBe(56);
    expect(r.pointsA).toBe(22);
  });
});

// ─── buildRoundMatch ──────────────────────────────────────────────────────────

describe("buildRoundMatch", () => {
  const holes = mkHoles(1);

  it("returns null when the group has fewer than two teams", () => {
    const group: ScorecardGroup = {
      group_id: "g1",
      group_number: 1,
      players: [
        mkPlayer("rpA1", "uA1", "Alice", "tA", "Team A", [{ h: 1, g: 4 }]),
        mkPlayer("rpA2", "uA2", "Amy", "tA", "Team A", [{ h: 1, g: 5 }]),
      ],
    };
    expect(buildRoundMatch(group, holes, "gross", true)).toBeNull();
  });

  it("orders teams by name and accumulates a running total", () => {
    const group = twoTeamGroup([{ h: 1, g: 4 }], [{ h: 1, g: 5 }], [{ h: 1, g: 5 }], [{ h: 1, g: 6 }]);
    const match = buildRoundMatch(group, holes, "gross", true)!;
    expect(match.teamA.name).toBe("Team A");
    expect(match.teamB.name).toBe("Team B");
    expect(match.holes[0].runningTotalA).toBe(11);
    expect(match.finalTotalA).toBe(11);
    expect(match.winner).toBe("A");
  });

  it("swaps perspective so the viewing team is Team A", () => {
    const group = twoTeamGroup([{ h: 1, g: 4 }], [{ h: 1, g: 5 }], [{ h: 1, g: 5 }], [{ h: 1, g: 6 }]);
    const def = buildRoundMatch(group, holes, "gross", true)!;
    const swapped = buildRoundMatch(group, holes, "gross", true, "tB")!;
    expect(swapped.teamA.teamId).toBe("tB");
    expect(swapped.finalTotalA).toBe(-def.finalTotalA);
  });

  it("uses net scores when basis is net", () => {
    // Gross ties (both 45); net gives Team A the edge. Flip disabled to isolate basis.
    const group = twoTeamGroup(
      [{ h: 1, g: 4, n: 3 }],
      [{ h: 1, g: 5, n: 4 }],
      [{ h: 1, g: 4, n: 4 }],
      [{ h: 1, g: 5, n: 5 }],
    );
    expect(buildRoundMatch(group, holes, "gross", false)!.finalTotalA).toBe(0);
    // Team A net 34 vs Team B net 45 → A wins by 11.
    expect(buildRoundMatch(group, holes, "net", false)!.finalTotalA).toBe(11);
  });
});

// twoTeamGroup builds a 4-player, two-team group from each player's score list.
function twoTeamGroup(a1: ScoreSpec[], a2: ScoreSpec[], b1: ScoreSpec[], b2: ScoreSpec[]): ScorecardGroup {
  return {
    group_id: "g1",
    group_number: 1,
    players: [
      mkPlayer("rpA1", "uA1", "Alice", "tA", "Team A", a1),
      mkPlayer("rpA2", "uA2", "Amy", "tA", "Team A", a2),
      mkPlayer("rpB1", "uB1", "Bob", "tB", "Team B", b1),
      mkPlayer("rpB2", "uB2", "Ben", "tB", "Team B", b2),
    ],
  };
}

// ─── Full worked 9-hole match (with flips) ──────────────────────────────────────

describe("buildRoundMatch — worked 9-hole match", () => {
  const holes = mkHoles(9);
  // Per-hole [A1, A2, B1, B2] gross on par-4 holes.
  const rows = [
    [4, 5, 5, 6], // +11  → run 11
    [4, 4, 3, 4], // B birdie flips A(44→44); A44 vs B34 → -10 → run 1
    [4, 4, 4, 4], //   0  → run 1
    [3, 4, 5, 5], // A birdie flips B(55→55); A34 vs B55 → +21 → run 22
    [5, 5, 4, 4], // -11  → run 11
    [4, 4, 4, 5], //  +1  → run 12
    [5, 6, 4, 5], // -11  → run 1
    [4, 4, 4, 4], //   0  → run 1
    [3, 3, 4, 5], // A birdie flips B(45→54); A33 vs B54 → +21 → run 22
  ];
  const group = twoTeamGroup(
    rows.map((r, i) => ({ h: i + 1, g: r[0] })),
    rows.map((r, i) => ({ h: i + 1, g: r[1] })),
    rows.map((r, i) => ({ h: i + 1, g: r[2] })),
    rows.map((r, i) => ({ h: i + 1, g: r[3] })),
  );

  it("computes per-hole points, flips, running totals, and the winner", () => {
    const match = buildRoundMatch(group, holes, "gross", true)!;
    expect(match.holes[0].pointsA).toBe(11);
    expect(match.holes[1].pointsA).toBe(-10);
    expect(match.holes[1].flipAppliedToA).toBe(true);
    expect(match.holes[3].pointsA).toBe(21);
    expect(match.holes[3].flipAppliedToB).toBe(true);
    expect(match.holes[8].teamBNumber).toBe(54); // flip(45)
    expect(match.holes.map((h) => h.runningTotalA)).toEqual([11, 1, 1, 22, 11, 12, 1, 1, 22]);
    expect(match.finalTotalA).toBe(22);
    expect(match.winner).toBe("A");
    expect(match.complete).toBe(true);
  });
});

// ─── buildRoundMatches ──────────────────────────────────────────────────────────

describe("buildRoundMatches", () => {
  it("builds a match per group with two teams and skips incomplete groups", () => {
    const holes = mkHoles(1);
    const full = twoTeamGroup([{ h: 1, g: 4 }], [{ h: 1, g: 5 }], [{ h: 1, g: 5 }], [{ h: 1, g: 6 }]);
    const oneTeam: ScorecardGroup = {
      group_id: "g2",
      group_number: 2,
      players: [mkPlayer("rpX", "uX", "Xander", "tX", "Team X", [{ h: 1, g: 4 }])],
    };
    const sc = mkScorecard({ holes, groups: [full, oneTeam] });
    const matches = buildRoundMatches(sc);
    expect(matches).toHaveLength(1);
    expect(matches[0].groupId).toBe("g1");
  });
});

// ─── normalizeStrokeIndexes / holeHandicapStrokes ──────────────────────────────

describe("normalizeStrokeIndexes", () => {
  it("ranks holes 1..N by ascending stroke index", () => {
    const holes: ScorecardHole[] = [
      { hole_number: 10, par: 4, stroke_index: 7, yardage: null },
      { hole_number: 11, par: 4, stroke_index: 3, yardage: null },
      { hole_number: 12, par: 4, stroke_index: 15, yardage: null },
    ];
    expect(normalizeStrokeIndexes(holes)).toEqual({ 11: 1, 10: 2, 12: 3 });
  });
});

describe("holeHandicapStrokes", () => {
  it("gives one stroke on the hardest holes within the handicap", () => {
    expect(holeHandicapStrokes(5, 5, 18)).toBe(1);
    expect(holeHandicapStrokes(5, 6, 18)).toBe(0);
  });
  it("gives two strokes on the hardest holes for high handicaps", () => {
    expect(holeHandicapStrokes(20, 2, 18)).toBe(2);
    expect(holeHandicapStrokes(20, 3, 18)).toBe(1);
  });
  it("returns 0 for non-positive inputs", () => {
    expect(holeHandicapStrokes(0, 1, 18)).toBe(0);
    expect(holeHandicapStrokes(10, 0, 18)).toBe(0);
  });
});

// ─── buildLiveVegasMatch ────────────────────────────────────────────────────────

describe("buildLiveVegasMatch", () => {
  const holes = mkHoles(1);
  const group = twoTeamGroup([], [], [], []); // scores supplied via localGross below

  it("combines live gross input from local state", () => {
    const local = {
      rpA1: { 1: "4" },
      rpA2: { 1: "5" },
      rpB1: { 1: "5" },
      rpB2: { 1: "6" },
    };
    const match = buildLiveVegasMatch(group, holes, local, "gross", true, {})!;
    expect(match.holes[0].teamANumber).toBe(45);
    expect(match.holes[0].teamBNumber).toBe(56);
    expect(match.finalTotalA).toBe(11);
  });

  it("applies handicap strokes for net basis", () => {
    // 18-hole course + handicap 18 → exactly one stroke on every hole.
    const holes18 = mkHoles(18);
    const local = {
      rpA1: { 1: "4" },
      rpA2: { 1: "5" },
      rpB1: { 1: "5" },
      rpB2: { 1: "6" },
    };
    const eff = { rpA1: 18, rpA2: 18, rpB1: 18, rpB2: 18 };
    const match = buildLiveVegasMatch(group, holes18, local, "net", false, eff)!;
    // Net subtracts 1 from each: A 3,4 → 34; B 4,5 → 45 → A wins by 11 on hole 1.
    expect(match.holes[0].teamANumber).toBe(34);
    expect(match.holes[0].teamBNumber).toBe(45);
  });

  it("ignores blank/invalid local entries (incomplete hole)", () => {
    const local = { rpA1: { 1: "4" }, rpB1: { 1: "5" }, rpB2: { 1: "6" } };
    const match = buildLiveVegasMatch(group, holes, local, "gross", true, {})!;
    expect(match.holes[0].complete).toBe(false);
    expect(match.holes[0].teamANumber).toBeNull();
  });
});

// ─── buildEventTally ────────────────────────────────────────────────────────────

describe("buildEventTally", () => {
  it("accumulates net points per player across rounds, skipping non-Vegas cards", () => {
    const holes = mkHoles(1);
    // Round 1: Team A (Alice+Amy) beats Team B (Bob+Ben) by 11.
    const r1 = mkScorecard({
      roundId: "r1",
      roundName: "R1",
      holes,
      groups: [twoTeamGroup([{ h: 1, g: 4 }], [{ h: 1, g: 5 }], [{ h: 1, g: 5 }], [{ h: 1, g: 6 }])],
    });
    // Round 2: same teams, Team B wins by 11 (A higher).
    const r2 = mkScorecard({
      roundId: "r2",
      roundName: "R2",
      holes,
      groups: [twoTeamGroup([{ h: 1, g: 5 }], [{ h: 1, g: 6 }], [{ h: 1, g: 4 }], [{ h: 1, g: 5 }])],
    });
    // A non-Vegas card must be ignored.
    const stroke = mkScorecard({ roundId: "r3", holes, groups: [], format: "stroke" });

    const tally = buildEventTally([r1, r2, stroke]);
    const alice = tally.find((t) => t.userId === "uA1")!;
    expect(alice.netPoints).toBe(0); // +11 then -11
    expect(alice.roundsPlayed).toBe(2);
    expect(alice.perRound).toHaveLength(2);
    expect(alice.perRound[0].partnerName).toBe("Amy");
    expect(alice.perRound[0].opponentNames).toEqual(["Bob", "Ben"]);
    expect(alice.perRound[0].netPoints).toBe(11);
    expect(alice.perRound[1].netPoints).toBe(-11);
  });

  it("sorts players by net points descending", () => {
    const holes = mkHoles(1);
    const r1 = mkScorecard({
      holes,
      groups: [twoTeamGroup([{ h: 1, g: 4 }], [{ h: 1, g: 4 }], [{ h: 1, g: 6 }], [{ h: 1, g: 6 }])],
    });
    const tally = buildEventTally([r1]);
    // Team A (44) beats Team B (66) by 22 → A players lead.
    expect(tally[0].netPoints).toBe(22);
    expect(tally[tally.length - 1].netPoints).toBe(-22);
  });
});
