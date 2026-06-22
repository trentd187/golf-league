// utils/holeGrid.ts
// Pure, hole-count-aware helpers for the course scorecard editor (HoleDataGrid).
// Kept React-free so the component stays a thin consumer and the logic — which
// is the part that actually has bugs (e.g. forcing 18 rows on a 9-hole course) —
// is unit-tested (components are excluded from coverage; utils are collected).
//
// A grid is driven by `holeCount` (9 or 18): rows, validation bounds, and the
// stroke-index permutation all scale to N rather than being hardcoded to 18.

import type { HoleRow } from "@/types/courses";

// EditRow mirrors HoleRow but uses strings for TextInput compatibility.
// Blank strings represent missing / not-yet-entered values.
export interface EditRow {
  par: string;
  strokeIndex: string;
  yardage: string;
}

// buildInitialEditRows creates `holeCount` blank rows, pre-filling from existing
// hole data (matched by hole_number).
export function buildInitialEditRows(holes: HoleRow[], holeCount: number): EditRow[] {
  return Array.from({ length: holeCount }, (_, i) => {
    const existing = holes.find((h) => h.hole_number === i + 1);
    return {
      par:         existing ? String(existing.par)          : "",
      strokeIndex: existing ? String(existing.stroke_index) : "",
      yardage:     existing?.yardage != null ? String(existing.yardage) : "",
    };
  });
}

// validateEditRows checks every row has par + stroke index filled in, pars are
// 3–5 (the backend rejects par 6), and stroke indexes form a permutation of
// 1–holeCount (in range, no duplicates). Returns the first error message, or
// null when valid.
export function validateEditRows(rows: EditRow[], holeCount: number): string | null {
  const siSet = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const hole = i + 1;
    const par = parseInt(rows[i].par, 10);
    const si  = parseInt(rows[i].strokeIndex, 10);

    if (!rows[i].par.trim() || isNaN(par)) {
      return `Hole ${hole}: par is required`;
    }
    if (par < 3 || par > 5) {
      return `Hole ${hole}: par must be between 3 and 5`;
    }
    if (!rows[i].strokeIndex.trim() || isNaN(si)) {
      return `Hole ${hole}: stroke index is required`;
    }
    if (si < 1 || si > holeCount) {
      return `Hole ${hole}: stroke index must be 1–${holeCount}`;
    }
    if (siSet.has(si)) {
      return `Stroke index ${si} is used more than once`;
    }
    siSet.add(si);
  }
  return null;
}

// editRowsAllFilled is true when every row has par + stroke index entered.
// Drives the Save button's enabled state (cheaper than full validation on keystroke).
export function editRowsAllFilled(rows: EditRow[]): boolean {
  return rows.every((r) => r.par.trim() !== "" && r.strokeIndex.trim() !== "");
}

// HolePayload is one hole in the bulk-replace PUT body.
export interface HolePayload {
  hole_number: number;
  par: number;
  stroke_index: number;
  yardage: number | null;
}

// editRowsToHolePayload maps the string-based edit rows to the API shape.
// hole_number is positional (row index + 1); blank yardage becomes null.
export function editRowsToHolePayload(rows: EditRow[]): HolePayload[] {
  return rows.map((row, i) => ({
    hole_number:  i + 1,
    par:          parseInt(row.par, 10),
    stroke_index: parseInt(row.strokeIndex, 10),
    yardage:      row.yardage.trim() ? parseInt(row.yardage, 10) : null,
  }));
}
