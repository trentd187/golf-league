// __tests__/app/(tabs)/stats.test.ts
// Unit tests for toPar() and scoreTextColor() from utils/stats.ts.
// These functions were originally in stats.tsx but are exported via utils/stats
// so they can be tested without importing the React screen.

import { toPar, scoreTextColor } from "@/utils/stats";

describe("toPar", () => {
  it("returns 'E' for even par", () => {
    expect(toPar(72, 72)).toBe("E");
    expect(toPar(36, 36)).toBe("E");
  });

  it("returns '+N' for scores over par", () => {
    expect(toPar(74, 72)).toBe("+2");
    expect(toPar(73, 72)).toBe("+1");
    expect(toPar(82, 72)).toBe("+10");
  });

  it("returns '-N' for scores under par", () => {
    expect(toPar(70, 72)).toBe("-2");
    expect(toPar(71, 72)).toBe("-1");
    expect(toPar(62, 72)).toBe("-10");
  });
});

describe("scoreTextColor", () => {
  it("returns 'text-yellow-500' for eagle or better", () => {
    expect(scoreTextColor(70, 72)).toBe("text-yellow-500"); // -2, eagle
    expect(scoreTextColor(69, 72)).toBe("text-yellow-500"); // -3, albatross
    expect(scoreTextColor(1, 5)).toBe("text-yellow-500");   // hole-in-one on par 5
  });

  it("returns 'text-green-600' for birdie", () => {
    expect(scoreTextColor(71, 72)).toBe("text-green-600");
    expect(scoreTextColor(2, 3)).toBe("text-green-600");
  });

  it("returns empty string for par", () => {
    expect(scoreTextColor(72, 72)).toBe("");
    expect(scoreTextColor(4, 4)).toBe("");
  });

  it("returns 'text-amber-500' for bogey", () => {
    expect(scoreTextColor(73, 72)).toBe("text-amber-500");
    expect(scoreTextColor(5, 4)).toBe("text-amber-500");
  });

  it("returns 'text-red-500' for double bogey or worse", () => {
    expect(scoreTextColor(74, 72)).toBe("text-red-500"); // double bogey
    expect(scoreTextColor(76, 72)).toBe("text-red-500"); // quadruple bogey
    expect(scoreTextColor(7, 4)).toBe("text-red-500");   // triple bogey on par 4
  });
});
