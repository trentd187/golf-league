// __tests__/utils/scorecard.test.ts
// Unit tests for the pure scorecard auto-fill helpers in utils/scorecard.ts.

import { girScoreFromPutts, girPuttsHint, puttDistanceMirror, holeRangeTotal, moveStatUp, moveStatDown, numericStatFocusNext, scoreFocusNext, initScores, initStats, initHandicaps, holeStatEntryEquals, threeWayMergeScores, threeWayMergeStats, threeWayMergeHandicaps } from "@/utils/scorecard";
import type { HoleStatEntry } from "@/utils/scorecard";
import type { ScorecardPlayer } from "@/types/scorecard";

// ─── girScoreFromPutts ────────────────────────────────────────────────────────

describe("girScoreFromPutts", () => {
  it("par 4 + 2 putts = 4", () => {
    expect(girScoreFromPutts(4, 2)).toBe(4);
  });

  it("par 3 + 1 putt = 2 (birdie)", () => {
    expect(girScoreFromPutts(3, 1)).toBe(2);
  });

  it("par 5 + 3 putts = 6 (bogey)", () => {
    expect(girScoreFromPutts(5, 3)).toBe(6);
  });

  it("par 4 + 1 putt = 3 (birdie)", () => {
    expect(girScoreFromPutts(4, 1)).toBe(3);
  });
});

// ─── girPuttsHint ─────────────────────────────────────────────────────────────

describe("girPuttsHint", () => {
  it("returns '1' when gross is one under par (birdie)", () => {
    expect(girPuttsHint(4, 3)).toBe("1");
    expect(girPuttsHint(3, 2)).toBe("1");
    expect(girPuttsHint(5, 4)).toBe("1");
  });

  it("returns '2' when gross equals par", () => {
    expect(girPuttsHint(4, 4)).toBe("2");
    expect(girPuttsHint(3, 3)).toBe("2");
    expect(girPuttsHint(5, 5)).toBe("2");
  });

  it("returns null for bogey or better-than-birdie", () => {
    expect(girPuttsHint(4, 5)).toBeNull(); // bogey
    expect(girPuttsHint(4, 2)).toBeNull(); // eagle
    expect(girPuttsHint(5, 3)).toBeNull(); // eagle on par 5
  });
});

// ─── puttDistanceMirror ───────────────────────────────────────────────────────

describe("puttDistanceMirror", () => {
  it("mirrors value to first_putt_distance when editing putt_distance_made and putts = 1", () => {
    const result = puttDistanceMirror("putt_distance_made", "1", "15");
    expect(result).toEqual({ first_putt_distance: "15" });
  });

  it("mirrors value to putt_distance_made when editing first_putt_distance and putts = 1", () => {
    const result = puttDistanceMirror("first_putt_distance", "1", "20");
    expect(result).toEqual({ putt_distance_made: "20" });
  });

  it("returns empty object when putts is not 1", () => {
    expect(puttDistanceMirror("putt_distance_made",  "2", "15")).toEqual({});
    expect(puttDistanceMirror("first_putt_distance", "2", "20")).toEqual({});
    expect(puttDistanceMirror("putt_distance_made",  "",  "15")).toEqual({});
  });

  it("returns empty object for unrelated fields even when putts = 1", () => {
    expect(puttDistanceMirror("putts", "1", "1")).toEqual({});
    expect(puttDistanceMirror("approach_yds", "1", "100")).toEqual({});
  });
});

// ─── holeRangeTotal ───────────────────────────────────────────────────────────

describe("holeRangeTotal", () => {
  const frontNine = Array.from({ length: 9 }, (_, i) => ({ hole_number: i + 1, par: 4 }));
  const allEighteen = Array.from({ length: 18 }, (_, i) => ({ hole_number: i + 1, par: 4 }));

  it("sums par for holes 1–9", () => {
    expect(holeRangeTotal(frontNine, {}, 1, 9).par).toBe(36);
  });

  it("sums entered scores for all holes in range", () => {
    const scores: Record<number, string> = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [i + 1, "4"]),
    );
    expect(holeRangeTotal(frontNine, scores, 1, 9).score).toBe(36);
  });

  it("returns null score when no holes have a score", () => {
    expect(holeRangeTotal(frontNine, {}, 1, 9).score).toBeNull();
  });

  it("returns partial sum when only some holes are scored", () => {
    expect(holeRangeTotal(frontNine, { 1: "5", 2: "3" }, 1, 9).score).toBe(8);
  });

  it("ignores holes outside the requested range", () => {
    const backNineScores: Record<number, string> = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [i + 10, "4"]),
    );
    const result = holeRangeTotal(allEighteen, backNineScores, 1, 9);
    expect(result.score).toBeNull();
    expect(result.par).toBe(36);
  });

  it("sums par for back nine (10–18)", () => {
    expect(holeRangeTotal(allEighteen, {}, 10, 18).par).toBe(36);
  });
});

// ─── moveStatUp ───────────────────────────────────────────────────────────────

describe("moveStatUp", () => {
  it("moves a stat one position earlier", () => {
    expect(moveStatUp(["fir", "gir", "putts"], "gir")).toEqual(["gir", "fir", "putts"]);
  });

  it("returns the original reference when the key is already first", () => {
    const order = ["fir", "gir", "putts"];
    expect(moveStatUp(order, "fir")).toBe(order);
  });

  it("returns the original reference when the key is not found", () => {
    const order = ["fir", "gir"];
    expect(moveStatUp(order, "unknown")).toBe(order);
  });

  it("does not mutate the original array", () => {
    const order = ["fir", "gir", "putts"];
    const result = moveStatUp(order, "gir");
    expect(order).toEqual(["fir", "gir", "putts"]);
    expect(result).toEqual(["gir", "fir", "putts"]);
  });
});

// ─── moveStatDown ─────────────────────────────────────────────────────────────

describe("moveStatDown", () => {
  it("moves a stat one position later", () => {
    expect(moveStatDown(["fir", "gir", "putts"], "gir")).toEqual(["fir", "putts", "gir"]);
  });

  it("returns the original reference when the key is already last", () => {
    const order = ["fir", "gir", "putts"];
    expect(moveStatDown(order, "putts")).toBe(order);
  });

  it("returns the original reference when the key is not found", () => {
    const order = ["fir", "gir"];
    expect(moveStatDown(order, "unknown")).toBe(order);
  });

  it("does not mutate the original array", () => {
    const order = ["fir", "gir", "putts"];
    const result = moveStatDown(order, "gir");
    expect(order).toEqual(["fir", "gir", "putts"]);
    expect(result).toEqual(["fir", "putts", "gir"]);
  });
});

// ─── numericStatFocusNext ─────────────────────────────────────────────────────

describe("numericStatFocusNext", () => {
  it("returns next index when not the last stat (score position irrelevant)", () => {
    expect(numericStatFocusNext(0, 3, "last")).toBe(1);
    expect(numericStatFocusNext(1, 3, "last")).toBe(2);
    expect(numericStatFocusNext(0, 3, "first")).toBe(1);
  });

  it("returns 'score' when last stat and score_position is 'last'", () => {
    expect(numericStatFocusNext(2, 3, "last")).toBe("score");
  });

  it("returns 'score' when the only stat and score_position is 'last'", () => {
    expect(numericStatFocusNext(0, 1, "last")).toBe("score");
  });

  it("returns null when last stat and score_position is 'first' (score already above)", () => {
    expect(numericStatFocusNext(2, 3, "first")).toBeNull();
  });

  it("returns null when the only stat and score_position is 'first'", () => {
    expect(numericStatFocusNext(0, 1, "first")).toBeNull();
  });

  it("handles two stats: first chains to second regardless of score position", () => {
    expect(numericStatFocusNext(0, 2, "last")).toBe(1);
    expect(numericStatFocusNext(0, 2, "first")).toBe(1);
  });

  it("handles two stats: second chains to score when score is last", () => {
    expect(numericStatFocusNext(1, 2, "last")).toBe("score");
  });

  it("handles two stats: second dismisses when score is first", () => {
    expect(numericStatFocusNext(1, 2, "first")).toBeNull();
  });
});

// ─── scoreFocusNext ───────────────────────────────────────────────────────────

describe("scoreFocusNext", () => {
  it("returns 0 (first stat index) when score is first and there are numeric stats", () => {
    expect(scoreFocusNext("first", 3)).toBe(0);
    expect(scoreFocusNext("first", 1)).toBe(0);
  });

  it("returns null when score is first but there are no numeric stats", () => {
    expect(scoreFocusNext("first", 0)).toBeNull();
  });

  it("returns null when score is last (score is the final input — keyboard dismisses)", () => {
    expect(scoreFocusNext("last", 3)).toBeNull();
    expect(scoreFocusNext("last", 1)).toBeNull();
    expect(scoreFocusNext("last", 0)).toBeNull();
  });
});

// ─── Fixtures for init + merge tests ──────────────────────────────────────────

// entry builds a HoleStatEntry with the same all-empty defaults the screen uses, so a
// user-edited entry compares equal to the server-derived one once the save lands.
function entry(overrides: Partial<HoleStatEntry> = {}): HoleStatEntry {
  return {
    gir: null, gir_miss_direction: null,
    fir: null, fir_miss_direction: null,
    fir_ob: null, gir_ob: null,
    putts: "", first_putt_distance: "", putt_distance_made: "", approach_yds: "",
    tee_shot_club: null, tee_shot_distance: "",
    ...overrides,
  };
}

function player(overrides: Partial<ScorecardPlayer> = {}): ScorecardPlayer {
  return {
    round_player_id: "rp1",
    user_id: "u1",
    display_name: "Player",
    avatar_url: null,
    course_handicap: null,
    effective_course_handicap: null,
    team_id: null,
    team_name: null,
    scores: [],
    hole_stats: [],
    total_gross: null,
    total_net: null,
    ...overrides,
  };
}

// ─── initScores / initHandicaps / initStats ───────────────────────────────────

describe("initScores", () => {
  it("builds a hole→string map per player from server scores", () => {
    const p = player({
      scores: [
        { hole_number: 1, gross_score: 4, net_score: 4 },
        { hole_number: 2, gross_score: 5, net_score: 4 },
      ],
    });
    expect(initScores([p])).toEqual({ rp1: { 1: "4", 2: "5" } });
  });

  it("yields an empty map for a player with no scores", () => {
    expect(initScores([player()])).toEqual({ rp1: {} });
  });
});

describe("initHandicaps", () => {
  it("stringifies course_handicap and uses '' for null", () => {
    const withHcp = player({ round_player_id: "a", course_handicap: 12 });
    const noHcp = player({ round_player_id: "b", course_handicap: null });
    expect(initHandicaps([withHcp, noHcp])).toEqual({ a: "12", b: "" });
  });
});

describe("initStats", () => {
  it("maps server hole_stats into editable string-form entries", () => {
    const p = player({
      hole_stats: [
        {
          hole_number: 1, gir: "hit", gir_miss_direction: null,
          fir: true, fir_miss_direction: null, fir_ob: null, gir_ob: null,
          putts: 2, first_putt_distance: 15, putt_distance_made: null,
          approach_yds: null, tee_shot_club: "DR", tee_shot_distance: 250,
        },
      ],
    });
    expect(initStats([p])).toEqual({
      rp1: {
        1: entry({ gir: "hit", fir: true, putts: "2", first_putt_distance: "15", tee_shot_club: "DR", tee_shot_distance: "250" }),
      },
    });
  });
});

// ─── holeStatEntryEquals ──────────────────────────────────────────────────────

describe("holeStatEntryEquals", () => {
  it("is true for two structurally identical entries", () => {
    expect(holeStatEntryEquals(entry({ gir: "hit", putts: "2" }), entry({ gir: "hit", putts: "2" }))).toBe(true);
  });

  it("is false when any field differs", () => {
    expect(holeStatEntryEquals(entry({ putts: "2" }), entry({ putts: "3" }))).toBe(false);
    expect(holeStatEntryEquals(entry({ gir: "hit" }), entry({ gir: "miss" }))).toBe(false);
    expect(holeStatEntryEquals(entry({ fir_ob: true }), entry({ fir_ob: null }))).toBe(false);
  });
});

// ─── threeWayMergeScores ──────────────────────────────────────────────────────

describe("threeWayMergeScores", () => {
  it("adopts the server snapshot on the first sync (empty base + local)", () => {
    expect(threeWayMergeScores({}, {}, { rp1: { 1: "4" } })).toEqual({ rp1: { 1: "4" } });
  });

  it("flows in a peer's new score when this device hasn't diverged", () => {
    const base = { rp1: { 1: "4" } };
    const local = { rp1: { 1: "4" } };
    const incoming = { rp1: { 1: "4" }, rp2: { 1: "5" } };
    expect(threeWayMergeScores(base, local, incoming)).toEqual({ rp1: { 1: "4" }, rp2: { 1: "5" } });
  });

  it("flows in a peer's changed score (local matched the old base)", () => {
    expect(threeWayMergeScores({ rp2: { 1: "5" } }, { rp2: { 1: "5" } }, { rp2: { 1: "6" } })).toEqual({ rp2: { 1: "6" } });
  });

  it("preserves an unsaved local edit when the server snapshot is still stale", () => {
    // base has no hole 1; local typed "4"; server hasn't received it yet.
    expect(threeWayMergeScores({ rp1: {} }, { rp1: { 1: "4" } }, { rp1: {} })).toEqual({ rp1: { 1: "4" } });
  });

  it("graduates a local edit back to server control once the server echoes it", () => {
    expect(threeWayMergeScores({ rp1: {} }, { rp1: { 1: "4" } }, { rp1: { 1: "4" } })).toEqual({ rp1: { 1: "4" } });
  });

  it("omits blank cells so a missing key and '' stay equivalent", () => {
    expect(threeWayMergeScores({ rp1: {} }, { rp1: { 1: "" } }, { rp1: {} })).toEqual({ rp1: {} });
  });
});

// ─── threeWayMergeStats ───────────────────────────────────────────────────────

describe("threeWayMergeStats", () => {
  it("flows in a peer's new hole stat when this device hasn't diverged", () => {
    const incoming = { rp1: { 1: entry({ gir: "hit" }) } };
    expect(threeWayMergeStats({ rp1: {} }, { rp1: {} }, incoming)).toEqual(incoming);
  });

  it("preserves an unsaved local stat when the server snapshot is stale", () => {
    const local = { rp1: { 1: entry({ gir: "hit", putts: "2" }) } };
    expect(threeWayMergeStats({ rp1: {} }, local, { rp1: {} })).toEqual(local);
  });

  it("graduates a local stat once the server echoes the same values", () => {
    const local = { rp1: { 1: entry({ gir: "hit", putts: "2" }) } };
    const incoming = { rp1: { 1: entry({ gir: "hit", putts: "2" }) } };
    expect(threeWayMergeStats({ rp1: {} }, local, incoming)).toEqual(incoming);
  });
});

// ─── threeWayMergeHandicaps ───────────────────────────────────────────────────

describe("threeWayMergeHandicaps", () => {
  it("adopts the server handicap on first sync", () => {
    expect(threeWayMergeHandicaps({}, {}, { rp1: "10" })).toEqual({ rp1: "10" });
  });

  it("preserves an unsaved local handicap edit when the server is stale", () => {
    expect(threeWayMergeHandicaps({ rp1: "" }, { rp1: "12" }, { rp1: "" })).toEqual({ rp1: "12" });
  });

  it("flows in a saved handicap when local matched the old base", () => {
    expect(threeWayMergeHandicaps({ rp1: "" }, { rp1: "" }, { rp1: "9" })).toEqual({ rp1: "9" });
  });
});
