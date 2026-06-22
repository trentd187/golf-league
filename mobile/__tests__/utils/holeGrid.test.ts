// __tests__/utils/holeGrid.test.ts
// Unit tests for the pure scorecard-grid helpers used by HoleDataGrid.
// Focus: the grid must scale to the course's hole count (9 or 18) instead of
// always demanding 18 holes.

import {
  buildInitialEditRows,
  validateEditRows,
  editRowsAllFilled,
  editRowsToHolePayload,
  type EditRow,
} from "@/utils/holeGrid";
import type { HoleRow } from "@/types/courses";

// makeRows builds N edit rows where every row is a valid par-4 with stroke
// index = hole number (a clean 1..N permutation), then applies overrides.
function makeRows(count: number, overrides: Record<number, Partial<EditRow>> = {}): EditRow[] {
  return Array.from({ length: count }, (_, i) => ({
    par: "4",
    strokeIndex: String(i + 1),
    yardage: "",
    ...overrides[i],
  }));
}

describe("buildInitialEditRows", () => {
  it("creates exactly holeCount blank rows when there is no existing data", () => {
    expect(buildInitialEditRows([], 9)).toHaveLength(9);
    expect(buildInitialEditRows([], 18)).toHaveLength(18);
    expect(buildInitialEditRows([], 9)[0]).toEqual({ par: "", strokeIndex: "", yardage: "" });
  });

  it("pre-fills rows from matching existing holes", () => {
    const holes: HoleRow[] = [
      { hole_number: 1, par: 4, stroke_index: 5, yardage: 410 },
      { hole_number: 2, par: 3, stroke_index: 17, yardage: null },
    ];
    const rows = buildInitialEditRows(holes, 9);
    expect(rows[0]).toEqual({ par: "4", strokeIndex: "5", yardage: "410" });
    // null yardage becomes a blank string
    expect(rows[1]).toEqual({ par: "3", strokeIndex: "17", yardage: "" });
    // holes without data stay blank
    expect(rows[2]).toEqual({ par: "", strokeIndex: "", yardage: "" });
  });
});

describe("validateEditRows", () => {
  it("accepts a full, valid 18-hole grid", () => {
    expect(validateEditRows(makeRows(18), 18)).toBeNull();
  });

  it("accepts a full, valid 9-hole grid (the bug fix)", () => {
    expect(validateEditRows(makeRows(9), 9)).toBeNull();
  });

  it("requires par on every row", () => {
    const rows = makeRows(9, { 3: { par: "" } });
    expect(validateEditRows(rows, 9)).toBe("Hole 4: par is required");
  });

  it("rejects par outside 3–5 (par 6 is rejected to match the backend)", () => {
    expect(validateEditRows(makeRows(9, { 0: { par: "6" } }), 9)).toBe(
      "Hole 1: par must be between 3 and 5",
    );
    expect(validateEditRows(makeRows(9, { 0: { par: "2" } }), 9)).toBe(
      "Hole 1: par must be between 3 and 5",
    );
  });

  it("requires a stroke index on every row", () => {
    const rows = makeRows(9, { 2: { strokeIndex: "" } });
    expect(validateEditRows(rows, 9)).toBe("Hole 3: stroke index is required");
  });

  it("rejects a stroke index above holeCount for a 9-hole course", () => {
    const rows = makeRows(9, { 8: { strokeIndex: "10" } });
    expect(validateEditRows(rows, 9)).toBe("Hole 9: stroke index must be 1–9");
  });

  it("still allows stroke index up to 18 on an 18-hole course", () => {
    const rows = makeRows(18, { 17: { strokeIndex: "18" } });
    expect(validateEditRows(rows, 18)).toBeNull();
  });

  it("rejects a stroke index below 1", () => {
    const rows = makeRows(9, { 0: { strokeIndex: "0" } });
    expect(validateEditRows(rows, 9)).toBe("Hole 1: stroke index must be 1–9");
  });

  it("rejects a duplicate stroke index", () => {
    const rows = makeRows(9, { 1: { strokeIndex: "1" } });
    expect(validateEditRows(rows, 9)).toBe("Stroke index 1 is used more than once");
  });
});

describe("editRowsAllFilled", () => {
  it("is true when every row has par and stroke index", () => {
    expect(editRowsAllFilled(makeRows(9))).toBe(true);
  });

  it("is false when any row is missing par or stroke index", () => {
    expect(editRowsAllFilled(makeRows(9, { 4: { par: "" } }))).toBe(false);
    expect(editRowsAllFilled(makeRows(9, { 4: { strokeIndex: "  " } }))).toBe(false);
  });
});

describe("editRowsToHolePayload", () => {
  it("maps rows to the API shape with positional hole numbers", () => {
    const rows = makeRows(2, { 0: { yardage: "410" } });
    expect(editRowsToHolePayload(rows)).toEqual([
      { hole_number: 1, par: 4, stroke_index: 1, yardage: 410 },
      { hole_number: 2, par: 4, stroke_index: 2, yardage: null },
    ]);
  });
});
