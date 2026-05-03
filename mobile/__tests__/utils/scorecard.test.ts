// __tests__/utils/scorecard.test.ts
// Unit tests for the pure scorecard auto-fill helpers in utils/scorecard.ts.

import { girScoreFromPutts, girPuttsHint, puttDistanceMirror } from "@/utils/scorecard";

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
