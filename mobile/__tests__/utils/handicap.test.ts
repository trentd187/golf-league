// __tests__/utils/handicap.test.ts
// Unit tests for the pure handicap helpers: stroke allocation (including plus
// handicaps, which ADD strokes on the easiest holes) and the golf-notation input
// parsing / display formatting shared by registered-player and guest entry.

import {
  holeHandicapStrokes,
  parseCourseHandicapInput,
  formatCourseHandicap,
  formatCourseHandicapWithAllowance,
  formatHoleStrokeAdjustment,
} from "@/utils/handicap";

describe("holeHandicapStrokes — regular (receiving) handicaps", () => {
  it("gives one stroke on the hardest holes within the handicap", () => {
    expect(holeHandicapStrokes(5, 1, 18)).toBe(1);
    expect(holeHandicapStrokes(5, 5, 18)).toBe(1);
    expect(holeHandicapStrokes(5, 6, 18)).toBe(0);
  });

  it("gives two strokes on the hardest holes for a high handicap", () => {
    expect(holeHandicapStrokes(20, 1, 18)).toBe(2);
    expect(holeHandicapStrokes(20, 2, 18)).toBe(2);
    expect(holeHandicapStrokes(20, 3, 18)).toBe(1);
  });

  it("returns 0 for scratch or non-positive index/count", () => {
    expect(holeHandicapStrokes(0, 1, 18)).toBe(0);
    expect(holeHandicapStrokes(10, 0, 18)).toBe(0);
    expect(holeHandicapStrokes(10, 1, 0)).toBe(0);
  });
});

describe("holeHandicapStrokes — plus handicaps (giving strokes back)", () => {
  it("adds a stroke on the easiest hole only for +1 (stored -1)", () => {
    // net = gross - strokes, so -1 raises net by one on the easiest hole (SI 18).
    expect(holeHandicapStrokes(-1, 18, 18)).toBe(-1);
    expect(holeHandicapStrokes(-1, 17, 18)).toBe(0);
    expect(holeHandicapStrokes(-1, 1, 18)).toBe(0);
  });

  it("adds strokes on the two easiest holes for +2 (stored -2)", () => {
    expect(holeHandicapStrokes(-2, 18, 18)).toBe(-1);
    expect(holeHandicapStrokes(-2, 17, 18)).toBe(-1);
    expect(holeHandicapStrokes(-2, 16, 18)).toBe(0);
  });

  it("adds one stroke on every hole for a full-pass plus handicap (-18)", () => {
    for (let si = 1; si <= 18; si++) {
      expect(holeHandicapStrokes(-18, si, 18)).toBe(-1);
    }
  });

  it("allocates on the easiest of a 9-hole round", () => {
    expect(holeHandicapStrokes(-1, 9, 9)).toBe(-1);
    expect(holeHandicapStrokes(-1, 8, 9)).toBe(0);
  });
});

describe("parseCourseHandicapInput", () => {
  it("parses a regular handicap", () => {
    expect(parseCourseHandicapInput("12")).toBe(12);
    expect(parseCourseHandicapInput("  8 ")).toBe(8);
    expect(parseCourseHandicapInput("0")).toBe(0);
  });

  it("parses a plus handicap in golf notation (+N → negative)", () => {
    expect(parseCourseHandicapInput("+2")).toBe(-2);
    expect(parseCourseHandicapInput("+1")).toBe(-1);
    expect(parseCourseHandicapInput("+0")).toBe(0);
  });

  it("returns null for empty, a bare minus, decimals, or junk", () => {
    expect(parseCourseHandicapInput("")).toBeNull();
    expect(parseCourseHandicapInput("   ")).toBeNull();
    expect(parseCourseHandicapInput("-2")).toBeNull();
    expect(parseCourseHandicapInput("1.5")).toBeNull();
    expect(parseCourseHandicapInput("abc")).toBeNull();
    expect(parseCourseHandicapInput("1a")).toBeNull();
  });

  it("round-trips with formatCourseHandicap", () => {
    for (const stored of [-2, -1, 0, 5, 12, 54]) {
      expect(parseCourseHandicapInput(formatCourseHandicap(stored))).toBe(stored);
    }
  });
});

describe("formatCourseHandicap", () => {
  it("shows a plus handicap with a + prefix", () => {
    expect(formatCourseHandicap(-2)).toBe("+2");
    expect(formatCourseHandicap(-1)).toBe("+1");
  });

  it("shows scratch and regular handicaps as plain numbers", () => {
    expect(formatCourseHandicap(0)).toBe("0");
    expect(formatCourseHandicap(12)).toBe("12");
  });
});

describe("formatCourseHandicapWithAllowance", () => {
  it("returns empty string when the handicap is unset", () => {
    expect(formatCourseHandicapWithAllowance(null, null, true)).toBe("");
    expect(formatCourseHandicapWithAllowance(undefined, 5, true)).toBe("");
  });

  it("shows only the base handicap when no allowance is active", () => {
    expect(formatCourseHandicapWithAllowance(12, 11, false)).toBe("12");
    expect(formatCourseHandicapWithAllowance(-2, -2, false)).toBe("+2");
  });

  it("appends the effective handicap when an allowance changes it", () => {
    expect(formatCourseHandicapWithAllowance(12, 11, true)).toBe("12 → 11");
    expect(formatCourseHandicapWithAllowance(-2, -1, true)).toBe("+2 → +1");
  });

  it("omits the arrow when the allowance leaves the value unchanged", () => {
    expect(formatCourseHandicapWithAllowance(10, 10, true)).toBe("10");
  });
});

describe("formatHoleStrokeAdjustment", () => {
  it("shows a received stroke as a subtraction", () => {
    expect(formatHoleStrokeAdjustment(1)).toBe("−1");
    expect(formatHoleStrokeAdjustment(2)).toBe("−2");
  });

  it("shows a given (plus-handicap) stroke as an addition", () => {
    expect(formatHoleStrokeAdjustment(-1)).toBe("+1");
    expect(formatHoleStrokeAdjustment(-2)).toBe("+2");
  });
});
