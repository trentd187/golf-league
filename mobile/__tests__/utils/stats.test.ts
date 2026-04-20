// __tests__/utils/stats.test.ts
// Unit tests for buildStats(), buildRoundStats(), buildMyStats(), and findMyPlayer()
// in utils/stats.ts. All functions are pure — no mocking needed.

import { buildStats, buildRoundStats, buildMyStats, findMyPlayer } from "@/utils/stats";
import type { Scorecard, ScorecardPlayer, ScorecardHole } from "@/types/scorecard";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// makeHole: convenience factory for ScorecardHole test data.
function makeHole(hole_number: number, par: number): ScorecardHole {
  return { hole_number, par, stroke_index: hole_number, yardage: null };
}

// makePlayer: builds a minimal ScorecardPlayer with controllable fields.
function makePlayer(overrides: Partial<ScorecardPlayer> = {}): ScorecardPlayer {
  return {
    round_player_id: "rp-1",
    user_id: "user-1",
    display_name: "Alice",
    course_handicap: null,
    scores: [],
    hole_stats: [],
    total_gross: null,
    total_net: null,
    ...overrides,
  };
}

// makeScorecard: minimal valid Scorecard for one player in one group.
function makeScorecard(overrides: Partial<Scorecard> & { player?: ScorecardPlayer } = {}): Scorecard {
  const { player, ...rest } = overrides;
  return {
    round_id: "round-1",
    round_name: "Test Round",
    status: "completed",
    hole_count: 18,
    requires_handicap: false,
    scoring_format: "stroke",
    caller_user_id: "user-1",
    is_organizer: false,
    nine_hole_selection: null,
    holes: Array.from({ length: 18 }, (_, i) => makeHole(i + 1, i % 3 === 0 ? 3 : i % 3 === 1 ? 4 : 5)),
    groups: [{ group_id: "g-1", group_number: 1, players: [player ?? makePlayer()] }],
    ...rest,
  };
}

// ─── buildStats ───────────────────────────────────────────────────────────────

describe("buildStats", () => {
  it("returns 4 categories with empty top3 for empty input", () => {
    const result = buildStats([]);
    expect(result).toHaveLength(4);
    expect(result.every((r) => r.top3.length === 0)).toBe(true);
  });

  it("ranks a single player correctly in all categories", () => {
    const player = makePlayer({
      scores: [
        { hole_number: 1, gross_score: 2, net_score: 2 }, // birdie on par-3
        { hole_number: 2, gross_score: 4, net_score: 4 }, // par on par-4
      ],
      hole_stats: [
        { hole_number: 1, gir: "hit", gir_miss_direction: null, fir: true, fir_miss_direction: null,
          putts: 2, first_putt_distance: null, putt_distance_made: null, approach_yds: null },
      ],
    });
    const sc = makeScorecard({ player });
    const result = buildStats([sc]);
    const birdies = result.find((r) => r.category === "Birdies")!;
    expect(birdies.top3).toHaveLength(1);
    expect(birdies.top3[0].value).toBe(1);
    expect(birdies.top3[0].rank).toBe("1");
  });

  it("assigns 'T1' rank when two players tie", () => {
    const p1 = makePlayer({ user_id: "u1", display_name: "Alice",
      scores: [{ hole_number: 1, gross_score: 2, net_score: 2 }],
      hole_stats: [] });
    const p2 = makePlayer({ user_id: "u2", display_name: "Bob",
      scores: [{ hole_number: 1, gross_score: 2, net_score: 2 }],
      hole_stats: [] });
    const sc = makeScorecard({
      caller_user_id: "u1",
      groups: [{ group_id: "g-1", group_number: 1, players: [p1, p2] }],
    });
    const birdies = buildStats([sc]).find((r) => r.category === "Birdies")!;
    expect(birdies.top3[0].rank).toBe("T1");
    expect(birdies.top3[0].names).toContain("Alice");
    expect(birdies.top3[0].names).toContain("Bob");
  });

  it("excludes a player with 0 birdies from the birdies leaderboard", () => {
    const player = makePlayer({
      scores: [{ hole_number: 2, gross_score: 4, net_score: 4 }], // par, no birdie
      hole_stats: [],
    });
    const sc = makeScorecard({ player });
    const birdies = buildStats([sc]).find((r) => r.category === "Birdies")!;
    expect(birdies.top3).toHaveLength(0);
  });

  it("deduplicates a player appearing in multiple scorecards", () => {
    const player = makePlayer({
      scores: [{ hole_number: 1, gross_score: 2, net_score: 2 }], // 1 birdie each round
      hole_stats: [],
    });
    const sc1 = makeScorecard({ round_id: "r1", player });
    const sc2 = makeScorecard({ round_id: "r2", player });
    const birdies = buildStats([sc1, sc2]).find((r) => r.category === "Birdies")!;
    // Alice appears once with 2 total birdies (1 per round, deduplicated by user_id).
    expect(birdies.top3).toHaveLength(1);
    expect(birdies.top3[0].value).toBe(2);
  });

  it("treats null putts as no data until at least one round has real data", () => {
    const p1 = makePlayer({ user_id: "u1", display_name: "Alice",
      hole_stats: [{ hole_number: 1, gir: null, gir_miss_direction: null, fir: null, fir_miss_direction: null,
        putts: null, first_putt_distance: null, putt_distance_made: null, approach_yds: null }] });
    const sc = makeScorecard({ player: p1 });
    const putts = buildStats([sc]).find((r) => r.category === "Putts")!;
    // Player with only null putts should not appear on the leaderboard.
    expect(putts.top3).toHaveLength(0);
  });
});

// ─── findMyPlayer ─────────────────────────────────────────────────────────────

describe("findMyPlayer", () => {
  it("returns the caller's player from the first group", () => {
    const player = makePlayer({ user_id: "caller-id" });
    const sc = makeScorecard({ caller_user_id: "caller-id", player });
    expect(findMyPlayer(sc)).toBe(player);
  });

  it("returns undefined when the caller is not in any group", () => {
    const sc = makeScorecard({ caller_user_id: "nobody" });
    expect(findMyPlayer(sc)).toBeUndefined();
  });

  it("finds the caller in a later group", () => {
    const other = makePlayer({ user_id: "other" });
    const me = makePlayer({ user_id: "me" });
    const sc = makeScorecard({
      caller_user_id: "me",
      groups: [
        { group_id: "g-1", group_number: 1, players: [other] },
        { group_id: "g-2", group_number: 2, players: [me] },
      ],
    });
    expect(findMyPlayer(sc)).toBe(me);
  });
});

// ─── buildRoundStats ──────────────────────────────────────────────────────────

describe("buildRoundStats", () => {
  const par72holes: ScorecardHole[] = [
    ...Array.from({ length: 4 }, (_, i) => makeHole(i + 1, 3)),   // holes 1-4: par 3
    ...Array.from({ length: 10 }, (_, i) => makeHole(i + 5, 4)),  // holes 5-14: par 4
    ...Array.from({ length: 4 }, (_, i) => makeHole(i + 15, 5)),  // holes 15-18: par 5
  ];

  it("returns all-null stats for a player with no scores or hole stats", () => {
    const player = makePlayer();
    const result = buildRoundStats(player, par72holes);
    expect(result.avgPar3).toBeNull();
    expect(result.avgPar4).toBeNull();
    expect(result.avgPar5).toBeNull();
    expect(result.firPercent).toBeNull();
    expect(result.girPercent).toBeNull();
    expect(result.avgPuttsPerRound).toBeNull();
  });

  it("counts scoring distribution correctly", () => {
    const player = makePlayer({
      scores: [
        { hole_number: 1, gross_score: 2, net_score: 2 }, // birdie (par 3)
        { hole_number: 5, gross_score: 4, net_score: 4 }, // par (par 4)
        { hole_number: 9, gross_score: 5, net_score: 5 }, // bogey (par 4)
        { hole_number: 13, gross_score: 6, net_score: 6 }, // double (par 4)
        { hole_number: 15, gross_score: 4, net_score: 4 }, // eagle (par 5, -2)
      ],
    });
    const result = buildRoundStats(player, par72holes);
    expect(result.birdies).toBe(2); // hole 1 and hole 15 are both ≤ -1
    expect(result.pars).toBe(1);
    expect(result.bogeys).toBe(1);
    expect(result.doubles).toBe(1);
  });

  it("calculates par-specific averages", () => {
    const player = makePlayer({
      scores: [
        { hole_number: 1, gross_score: 3, net_score: 3 }, // par 3 → avg 3.0
        { hole_number: 2, gross_score: 4, net_score: 4 }, // par 3 → avg (3+4)/2=3.5
        { hole_number: 5, gross_score: 5, net_score: 5 }, // par 4 → avg 5.0
        { hole_number: 15, gross_score: 6, net_score: 6 }, // par 5 → avg 6.0
      ],
    });
    const result = buildRoundStats(player, par72holes);
    expect(result.avgPar3).toBeCloseTo(3.5);
    expect(result.avgPar4).toBeCloseTo(5.0);
    expect(result.avgPar5).toBeCloseTo(6.0);
  });

  it("calculates GIR% excluding 'na' holes from the denominator", () => {
    const player = makePlayer({
      hole_stats: [
        { hole_number: 1, gir: "hit",  gir_miss_direction: null, fir: null, fir_miss_direction: null,
          putts: null, first_putt_distance: null, putt_distance_made: null, approach_yds: null },
        { hole_number: 2, gir: "miss", gir_miss_direction: null, fir: null, fir_miss_direction: null,
          putts: null, first_putt_distance: null, putt_distance_made: null, approach_yds: null },
        // "na" hole: should be excluded from hit% denominator
        { hole_number: 3, gir: "na",   gir_miss_direction: null, fir: null, fir_miss_direction: null,
          putts: null, first_putt_distance: null, putt_distance_made: null, approach_yds: null },
      ],
    });
    const result = buildRoundStats(player, par72holes);
    // 1 hit / 2 eligible (hole 3 excluded) = 50%
    expect(result.girPercent).toBeCloseTo(50);
    // "na" hole is 1/3 of tracked holes = ~33%
    expect(result.girNaPercent).toBeCloseTo(33.33);
    expect(result.girTotal).toBe(2);
  });

  it("calculates FIR%", () => {
    const player = makePlayer({
      hole_stats: [
        { hole_number: 5, gir: null, gir_miss_direction: null, fir: true,  fir_miss_direction: null,
          putts: null, first_putt_distance: null, putt_distance_made: null, approach_yds: null },
        { hole_number: 6, gir: null, gir_miss_direction: null, fir: false, fir_miss_direction: "left",
          putts: null, first_putt_distance: null, putt_distance_made: null, approach_yds: null },
        { hole_number: 7, gir: null, gir_miss_direction: null, fir: false, fir_miss_direction: "right",
          putts: null, first_putt_distance: null, putt_distance_made: null, approach_yds: null },
      ],
    });
    const result = buildRoundStats(player, par72holes);
    // 1 hit / 3 tracked = 33.33%
    expect(result.firPercent).toBeCloseTo(33.33);
    expect(result.firMiss.left).toBe(1);
    expect(result.firMiss.right).toBe(1);
    expect(result.firTotal).toBe(3);
  });

  it("calculates putt distribution and avg putts normalised to 18 holes", () => {
    const player = makePlayer({
      hole_stats: [
        { hole_number: 1, gir: null, gir_miss_direction: null, fir: null, fir_miss_direction: null,
          putts: 1, first_putt_distance: null, putt_distance_made: null, approach_yds: null },
        { hole_number: 2, gir: null, gir_miss_direction: null, fir: null, fir_miss_direction: null,
          putts: 2, first_putt_distance: null, putt_distance_made: null, approach_yds: null },
        { hole_number: 3, gir: null, gir_miss_direction: null, fir: null, fir_miss_direction: null,
          putts: 3, first_putt_distance: null, putt_distance_made: null, approach_yds: null },
        { hole_number: 4, gir: null, gir_miss_direction: null, fir: null, fir_miss_direction: null,
          putts: 4, first_putt_distance: null, putt_distance_made: null, approach_yds: null },
      ],
    });
    const result = buildRoundStats(player, par72holes);
    expect(result.puttDist.one).toBe(1);
    expect(result.puttDist.two).toBe(1);
    expect(result.puttDist.three).toBe(1);
    expect(result.puttDist.fourPlus).toBe(1);
    // totalPutts=10, totalPuttHoles=4 → (10/4)*18 = 45
    expect(result.avgPuttsPerRound).toBeCloseTo(45);
  });
});

// ─── buildMyStats ─────────────────────────────────────────────────────────────

describe("buildMyStats", () => {
  const rounds = [{ id: "round-1", scheduled_date: "2026-01-15" }];

  it("returns all-null scores for empty input", () => {
    const result = buildMyStats([], []);
    expect(result.avgGrossScore).toBeNull();
    expect(result.lowScore).toBeNull();
    expect(result.highScore).toBeNull();
    expect(result.grossScores).toHaveLength(0);
  });

  it("includes an 18-hole round gross score in the averages", () => {
    const player = makePlayer({ total_gross: 80 });
    const sc = makeScorecard({ player });
    const result = buildMyStats([sc], [{ id: "round-1", scheduled_date: "2026-01-15" }]);
    expect(result.grossScores).toEqual([80]);
    expect(result.avgGrossScore).toBe(80);
    expect(result.lowScore).toBe(80);
    expect(result.highScore).toBe(80);
  });

  it("derives avg/low/high from multiple 18-hole rounds", () => {
    const sc1 = makeScorecard({ round_id: "r1", player: makePlayer({ total_gross: 72 }) });
    const sc2 = makeScorecard({ round_id: "r2", player: makePlayer({ total_gross: 80 }) });
    const roundsList = [
      { id: "r1", scheduled_date: "2026-01-01" },
      { id: "r2", scheduled_date: "2026-01-08" },
    ];
    const result = buildMyStats([sc1, sc2], roundsList);
    expect(result.avgGrossScore).toBe(76);
    expect(result.lowScore).toBe(72);
    expect(result.highScore).toBe(80);
  });

  it("pairs two 9-hole rounds into one 18-hole equivalent", () => {
    const front = makeScorecard({
      round_id: "r1",
      nine_hole_selection: "front",
      player: makePlayer({ total_gross: 38 }),
    });
    const back = makeScorecard({
      round_id: "r2",
      nine_hole_selection: "back",
      player: makePlayer({ total_gross: 40 }),
    });
    const roundsList = [
      { id: "r1", scheduled_date: "2026-01-15" },
      { id: "r2", scheduled_date: "2026-01-22" },
    ];
    const result = buildMyStats([front, back], roundsList);
    // Paired: 38 + 40 = 78 as one 18-hole score.
    expect(result.grossScores).toEqual([78]);
    expect(result.avgGrossScore).toBe(78);
  });

  it("excludes an unpaired 9-hole round from gross score averages", () => {
    const front = makeScorecard({
      round_id: "r1",
      nine_hole_selection: "front",
      player: makePlayer({ total_gross: 38 }),
    });
    const roundsList = [{ id: "r1", scheduled_date: "2026-01-15" }];
    const result = buildMyStats([front], roundsList);
    // Single 9-hole round has no pair — excluded from avg/low/high.
    expect(result.grossScores).toHaveLength(0);
    expect(result.avgGrossScore).toBeNull();
  });

  it("normalises avg putts to per-18-hole equivalent across mixed hole counts", () => {
    // 9-hole round with 2 putts on each of 9 holes = 18 total putts across 9 holes
    const nineHoleSc = makeScorecard({
      round_id: "r1",
      nine_hole_selection: "front",
      player: makePlayer({
        total_gross: 38,
        hole_stats: Array.from({ length: 9 }, (_, i) => ({
          hole_number: i + 1, gir: null as null, gir_miss_direction: null as null,
          fir: null as null, fir_miss_direction: null as null,
          putts: 2, first_putt_distance: null as null, putt_distance_made: null as null, approach_yds: null as null,
        })),
      }),
    });
    const roundsList = [{ id: "r1", scheduled_date: "2026-01-15" }];
    const result = buildMyStats([nineHoleSc], roundsList);
    // 18 total putts / 9 tracked holes × 18 = 36 avg per 18 holes
    expect(result.avgPuttsPerRound).toBeCloseTo(36);
  });

  it("accumulates GIR counts across rounds and excludes 'na' from percentage denominator", () => {
    const player = makePlayer({
      hole_stats: [
        { hole_number: 1, gir: "hit",  gir_miss_direction: null, fir: null, fir_miss_direction: null,
          putts: null, first_putt_distance: null, putt_distance_made: null, approach_yds: null },
        { hole_number: 2, gir: "miss", gir_miss_direction: null, fir: null, fir_miss_direction: null,
          putts: null, first_putt_distance: null, putt_distance_made: null, approach_yds: null },
        { hole_number: 3, gir: "na",   gir_miss_direction: null, fir: null, fir_miss_direction: null,
          putts: null, first_putt_distance: null, putt_distance_made: null, approach_yds: null },
      ],
    });
    const sc = makeScorecard({ player });
    const result = buildMyStats([sc], rounds);
    // 1 hit / 2 eligible = 50%; "na" = 1/3 tracked = ~33%
    expect(result.girPercent).toBeCloseTo(50);
    expect(result.girNaPercent).toBeCloseTo(33.33);
  });

  it("counts birdies, pars, bogeys, doubles across all rounds", () => {
    // makeScorecard hole pars: i%3===0→3, i%3===1→4, i%3===2→5
    // hole 1 (i=0)=par3, hole 2 (i=1)=par4, hole 5 (i=4)=par4, hole 6 (i=5)=par5
    const player = makePlayer({
      scores: [
        { hole_number: 1, gross_score: 2, net_score: 2 }, // birdie (par 3, -1)
        { hole_number: 2, gross_score: 4, net_score: 4 }, // par (par 4, 0)
        { hole_number: 5, gross_score: 5, net_score: 5 }, // bogey (par 4, +1)
        { hole_number: 6, gross_score: 7, net_score: 7 }, // double (par 5, +2)
      ],
    });
    const sc = makeScorecard({ player });
    const result = buildMyStats([sc], rounds);
    expect(result.birdiesOrBetter).toBe(1);
    expect(result.parsCount).toBe(1);
    expect(result.bogeysCount).toBe(1);
    expect(result.doublesPlus).toBe(1);
  });
});
