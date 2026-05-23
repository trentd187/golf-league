// __tests__/components/ScoreHistoryChart.test.tsx
// Tests for ScoreHistoryChart: empty state, filter visibility, and basic rendering.
// react-native-svg is handled by jest-expo's default transform (no manual mock needed).

import React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import ScoreHistoryChart from "@/components/ScoreHistoryChart";
import type { ScorePoint } from "@/utils/stats";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePoint(overrides: Partial<ScorePoint> = {}): ScorePoint {
  return {
    date: "2026-01-01",
    scoreToPar: 3,
    netScoreToPar: null,
    holeCount: 18,
    ...overrides,
  };
}

const eighteenHolePoints: ScorePoint[] = [
  makePoint({ date: "2026-01-01", scoreToPar: 5 }),
  makePoint({ date: "2026-02-01", scoreToPar: 3 }),
  makePoint({ date: "2026-03-01", scoreToPar: 1 }),
];

const nineHolePoints: ScorePoint[] = [
  makePoint({ date: "2026-01-15", scoreToPar: 2, holeCount: 9 }),
  makePoint({ date: "2026-02-15", scoreToPar: 4, holeCount: 9 }),
];

const mixedPoints: ScorePoint[] = [...eighteenHolePoints, ...nineHolePoints];

const pointsWithNet: ScorePoint[] = [
  makePoint({ date: "2026-01-01", scoreToPar: 5, netScoreToPar: 2 }),
  makePoint({ date: "2026-02-01", scoreToPar: 3, netScoreToPar: 0 }),
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ScoreHistoryChart", () => {
  it("renders the empty state when points is empty", () => {
    const { getByText } = render(<ScoreHistoryChart points={[]} />);
    expect(getByText("No rounds to display")).toBeTruthy();
  });

  it("renders without crashing for 18-hole-only points", () => {
    const { queryByText } = render(<ScoreHistoryChart points={eighteenHolePoints} />);
    expect(queryByText("No rounds to display")).toBeNull();
  });

  it("renders without crashing for mixed 9 and 18-hole points", () => {
    const { queryByText } = render(<ScoreHistoryChart points={mixedPoints} />);
    expect(queryByText("No rounds to display")).toBeNull();
  });

  it("shows the hole filter when both 9-hole and 18-hole points exist", () => {
    const { getByText } = render(<ScoreHistoryChart points={mixedPoints} />);
    expect(getByText("All")).toBeTruthy();
    expect(getByText("18 Holes")).toBeTruthy();
    expect(getByText("9 Holes")).toBeTruthy();
  });

  it("hides the hole filter when only 18-hole points exist", () => {
    const { queryByText } = render(<ScoreHistoryChart points={eighteenHolePoints} />);
    expect(queryByText("18 Holes")).toBeNull();
    expect(queryByText("9 Holes")).toBeNull();
  });

  it("hides the hole filter when only 9-hole points exist", () => {
    const { queryByText } = render(<ScoreHistoryChart points={nineHolePoints} />);
    expect(queryByText("18 Holes")).toBeNull();
    expect(queryByText("9 Holes")).toBeNull();
  });

  it("shows the Gross/Net toggle when at least one point has netScoreToPar", () => {
    const { getByText } = render(<ScoreHistoryChart points={pointsWithNet} />);
    expect(getByText("Gross")).toBeTruthy();
    expect(getByText("Net")).toBeTruthy();
  });

  it("hides the Gross/Net toggle when all netScoreToPar values are null", () => {
    const { queryByText } = render(<ScoreHistoryChart points={eighteenHolePoints} />);
    expect(queryByText("Gross")).toBeNull();
    expect(queryByText("Net")).toBeNull();
  });

  it("does not show empty state when switching hole filter to a type with matching points", () => {
    const { getByText, queryByText } = render(<ScoreHistoryChart points={mixedPoints} />);
    fireEvent.press(getByText("18 Holes"));
    expect(queryByText("No rounds to display")).toBeNull();
    expect(queryByText("No 18-hole rounds in this period")).toBeNull();
    fireEvent.press(getByText("9 Holes"));
    expect(queryByText("No 9-hole rounds in this period")).toBeNull();
  });

  it("shows chart (not empty) for a single-point dataset", () => {
    const { queryByText } = render(<ScoreHistoryChart points={[makePoint()]} />);
    expect(queryByText("No rounds to display")).toBeNull();
  });
});
