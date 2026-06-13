// __tests__/utils/bestBall.test.ts
// Unit tests for the pure Best Ball helpers in utils/bestBall.ts. Covers best-of-N
// selection, gross vs net, 2-team and 3+-team leaderboards with ties, partial/
// incomplete rounds, the live-input builder, and the event tally aggregation.

import {
  teamBestScore,
  buildBestBallMatch,
  buildBestBallRoundMatches,
  buildBestBallEventTally,
  buildLiveBestBallMatch,
  bestBallBasisOf,
} from "@/utils/bestBall";
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
    scoring_format: opts.format ?? "best_ball",
    vegas_birdie_flip: true,
    vegas_scoring_basis: "gross",
    best_ball_scoring_basis: opts.basis ?? "gross",
    caller_user_id: "u-a1",
    is_organizer: false,
    handicap_allowance: null,
    nine_hole_selection: null,
    holes: opts.holes,
    groups: opts.groups,
  };
}

// ─── teamBestScore ──────────────────────────────────────────────────────────────

describe("teamBestScore", () => {
  it("returns the lowest value and its owner", () => {
    const pick = teamBestScore([
      { roundPlayerId: "a", value: 5 },
      { roundPlayerId: "b", value: 3 },
      { roundPlayerId: "c", value: 7 },
    ]);
    expect(pick).toEqual({ best: 3, ownerRoundPlayerId: "b" });
  });
  it("skips null member scores", () => {
    const pick = teamBestScore([
      { roundPlayerId: "a", value: null },
      { roundPlayerId: "b", value: 4 },
    ]);
    expect(pick).toEqual({ best: 4, ownerRoundPlayerId: "b" });
  });
  it("keeps the first owner on a tie", () => {
    const pick = teamBestScore([
      { roundPlayerId: "a", value: 4 },
      { roundPlayerId: "b", value: 4 },
    ]);
    expect(pick.ownerRoundPlayerId).toBe("a");
  });
  it("returns nulls when no member scored", () => {
    expect(teamBestScore([{ roundPlayerId: "a", value: null }])).toEqual({ best: null, ownerRoundPlayerId: null });
    expect(teamBestScore([])).toEqual({ best: null, ownerRoundPlayerId: null });
  });
});

// ─── buildBestBallMatch ─────────────────────────────────────────────────────────

describe("buildBestBallMatch", () => {
  const holes = mkHoles(2);

  it("returns null when fewer than two teams", () => {
    const group: ScorecardGroup = {
      group_id: "g1",
      group_number: 1,
      players: [mkPlayer("rp1", "u1", "Ann", "T1", "Team 1", [{ h: 1, g: 4 }])],
    };
    expect(buildBestBallMatch(group, holes, "gross")).toBeNull();
  });

  it("takes the lowest member score per hole and sums team totals", () => {
    const group: ScorecardGroup = {
      group_id: "g1",
      group_number: 1,
      players: [
        mkPlayer("rp1", "u1", "Ann", "T1", "Team 1", [{ h: 1, g: 5 }, { h: 2, g: 4 }]),
        mkPlayer("rp2", "u2", "Bob", "T1", "Team 1", [{ h: 1, g: 4 }, { h: 2, g: 6 }]),
        mkPlayer("rp3", "u3", "Cal", "T2", "Team 2", [{ h: 1, g: 6 }, { h: 2, g: 5 }]),
        mkPlayer("rp4", "u4", "Dan", "T2", "Team 2", [{ h: 1, g: 5 }, { h: 2, g: 7 }]),
      ],
    };
    const match = buildBestBallMatch(group, holes, "gross")!;
    expect(match.complete).toBe(true);

    // Hole 1: T1 best = 4 (Bob), T2 best = 5 (Dan). Hole 2: T1 = 4 (Ann), T2 = 5 (Cal).
    const h1 = match.holes[0];
    const t1h1 = h1.teams.find((t) => t.teamId === "T1")!;
    expect(t1h1.best).toBe(4);
    expect(t1h1.ownerRoundPlayerId).toBe("rp2");
    // Totals: T1 = 8, T2 = 10 → T1 ranks first.
    const t1 = match.standings.find((s) => s.teamId === "T1")!;
    const t2 = match.standings.find((s) => s.teamId === "T2")!;
    expect(t1.total).toBe(8);
    expect(t2.total).toBe(10);
    expect(t1.rank).toBe(1);
    expect(t2.rank).toBe(2);
  });

  it("uses net scores when basis is net", () => {
    const group: ScorecardGroup = {
      group_id: "g1",
      group_number: 1,
      players: [
        mkPlayer("rp1", "u1", "Ann", "T1", "Team 1", [{ h: 1, g: 5, n: 4 }]),
        mkPlayer("rp2", "u2", "Bob", "T1", "Team 1", [{ h: 1, g: 4, n: 4 }]),
        mkPlayer("rp3", "u3", "Cal", "T2", "Team 2", [{ h: 1, g: 6, n: 3 }]),
        mkPlayer("rp4", "u4", "Dan", "T2", "Team 2", [{ h: 1, g: 5, n: 5 }]),
      ],
    };
    const match = buildBestBallMatch(group, mkHoles(1), "net")!;
    // Net: T1 best = 4, T2 best = 3 → T2 leads.
    expect(match.standings[0].teamId).toBe("T2");
    expect(match.standings[0].total).toBe(3);
  });

  it("ranks three teams and shares a rank on ties", () => {
    const group: ScorecardGroup = {
      group_id: "g1",
      group_number: 1,
      players: [
        mkPlayer("rp1", "u1", "Ann", "T1", "Team 1", [{ h: 1, g: 4 }]),
        mkPlayer("rp2", "u2", "Bob", "T2", "Team 2", [{ h: 1, g: 4 }]),
        mkPlayer("rp3", "u3", "Cal", "T3", "Team 3", [{ h: 1, g: 6 }]),
      ],
    };
    const match = buildBestBallMatch(group, mkHoles(1), "gross")!;
    expect(match.teams).toHaveLength(3);
    const t1 = match.standings.find((s) => s.teamId === "T1")!;
    const t2 = match.standings.find((s) => s.teamId === "T2")!;
    const t3 = match.standings.find((s) => s.teamId === "T3")!;
    expect(t1.rank).toBe(1);
    expect(t2.rank).toBe(1); // tied with T1
    expect(t3.rank).toBe(3); // rank jumps past the tie
  });

  it("marks the match incomplete and counts only scored holes", () => {
    const group: ScorecardGroup = {
      group_id: "g1",
      group_number: 1,
      players: [
        mkPlayer("rp1", "u1", "Ann", "T1", "Team 1", [{ h: 1, g: 4 }]), // no hole 2
        mkPlayer("rp2", "u2", "Bob", "T2", "Team 2", [{ h: 1, g: 5 }]),
      ],
    };
    const match = buildBestBallMatch(group, holes, "gross")!;
    expect(match.complete).toBe(false);
    const t1 = match.standings.find((s) => s.teamId === "T1")!;
    expect(t1.holesCounted).toBe(1);
    expect(t1.total).toBe(4);
  });

  it("moves the perspective team to the front", () => {
    const group: ScorecardGroup = {
      group_id: "g1",
      group_number: 1,
      players: [
        mkPlayer("rp1", "u1", "Ann", "T1", "Team 1", [{ h: 1, g: 4 }]),
        mkPlayer("rp2", "u2", "Bob", "T2", "Team 2", [{ h: 1, g: 5 }]),
      ],
    };
    const match = buildBestBallMatch(group, mkHoles(1), "gross", "T2")!;
    expect(match.teams[0].teamId).toBe("T2");
  });
});

// ─── buildLiveBestBallMatch ─────────────────────────────────────────────────────

describe("buildLiveBestBallMatch", () => {
  it("builds from live gross strings and applies handicap for net", () => {
    const holes = mkHoles(1);
    const group: ScorecardGroup = {
      group_id: "g1",
      group_number: 1,
      players: [
        mkPlayer("rp1", "u1", "Ann", "T1", "Team 1", []),
        mkPlayer("rp2", "u2", "Bob", "T2", "Team 2", []),
      ],
    };
    const localGross = { rp1: { 1: "5" }, rp2: { 1: "5" } };
    // rp1 gets 1 stroke on the hardest hole → net 4; rp2 plays off scratch → net 5.
    const match = buildLiveBestBallMatch(group, holes, localGross, "net", { rp1: 1, rp2: 0 })!;
    const t1 = match.standings.find((s) => s.teamId === "T1")!;
    const t2 = match.standings.find((s) => s.teamId === "T2")!;
    expect(t1.total).toBe(4);
    expect(t2.total).toBe(5);
  });

  it("ignores blank/invalid live entries", () => {
    const group: ScorecardGroup = {
      group_id: "g1",
      group_number: 1,
      players: [
        mkPlayer("rp1", "u1", "Ann", "T1", "Team 1", []),
        mkPlayer("rp2", "u2", "Bob", "T2", "Team 2", []),
      ],
    };
    const localGross = { rp1: { 1: "" }, rp2: { 1: "4" } };
    const match = buildLiveBestBallMatch(group, mkHoles(1), localGross, "gross", {})!;
    expect(match.complete).toBe(false);
    expect(match.standings.find((s) => s.teamId === "T1")!.holesCounted).toBe(0);
  });
});

// ─── buildBestBallRoundMatches & bestBallBasisOf ────────────────────────────────

describe("buildBestBallRoundMatches", () => {
  it("builds a match per qualifying group and skips groups without two teams", () => {
    const sc = mkScorecard({
      holes: mkHoles(1),
      groups: [
        {
          group_id: "g1",
          group_number: 1,
          players: [
            mkPlayer("rp1", "u1", "Ann", "T1", "Team 1", [{ h: 1, g: 4 }]),
            mkPlayer("rp2", "u2", "Bob", "T2", "Team 2", [{ h: 1, g: 5 }]),
          ],
        },
        {
          group_id: "g2",
          group_number: 2,
          players: [mkPlayer("rp3", "u3", "Cal", "T3", "Team 3", [{ h: 1, g: 4 }])],
        },
      ],
    });
    const matches = buildBestBallRoundMatches(sc);
    expect(matches).toHaveLength(1);
    expect(matches[0].groupId).toBe("g1");
  });
});

describe("bestBallBasisOf", () => {
  it("reads net and defaults everything else to gross", () => {
    expect(bestBallBasisOf(mkScorecard({ holes: [], groups: [], basis: "net" }))).toBe("net");
    expect(bestBallBasisOf(mkScorecard({ holes: [], groups: [], basis: "gross" }))).toBe("gross");
    expect(bestBallBasisOf(mkScorecard({ holes: [], groups: [], basis: "weird" }))).toBe("gross");
  });
});

// ─── buildBestBallEventTally ────────────────────────────────────────────────────

describe("buildBestBallEventTally", () => {
  const mkRound = (roundId: string, t1: number, t2: number): Scorecard =>
    mkScorecard({
      roundId,
      roundName: roundId,
      holes: mkHoles(1),
      groups: [
        {
          group_id: "g1",
          group_number: 1,
          players: [
            mkPlayer("rp1", "u1", "Ann", "T1", "Team 1", [{ h: 1, g: t1 }]),
            mkPlayer("rp2", "u2", "Bob", "T2", "Team 2", [{ h: 1, g: t2 }]),
          ],
        },
      ],
    });

  it("credits each member with their team's total, rank, and wins", () => {
    const tally = buildBestBallEventTally([mkRound("R1", 4, 5), mkRound("R2", 6, 5)]);
    const ann = tally.find((t) => t.userId === "u1")!;
    const bob = tally.find((t) => t.userId === "u2")!;
    // Ann (Team 1): R1 win (4), R2 loss (6) → 1 win, 10 strokes.
    expect(ann.wins).toBe(1);
    expect(ann.totalStrokes).toBe(10);
    expect(ann.roundsPlayed).toBe(2);
    // Bob (Team 2): R1 loss (5), R2 win (5) → 1 win, 10 strokes.
    expect(bob.wins).toBe(1);
    expect(bob.totalStrokes).toBe(10);
  });

  it("sorts by wins desc then fewest strokes", () => {
    const tally = buildBestBallEventTally([mkRound("R1", 4, 8), mkRound("R2", 4, 8)]);
    expect(tally[0].userId).toBe("u1"); // two wins, fewer strokes
    expect(tally[0].wins).toBe(2);
  });

  it("skips non-best-ball scorecards", () => {
    const stroke = mkScorecard({ holes: mkHoles(1), groups: [], format: "stroke" });
    expect(buildBestBallEventTally([stroke])).toEqual([]);
  });
});
