// __tests__/utils/scoringFormats.test.ts
// Unit tests for formatLabel() and formatToPar() in utils/scoringFormats.ts.

import { formatLabel, formatToPar, SCORING_FORMATS } from "@/utils/scoringFormats";

describe("formatLabel", () => {
  it("returns the human-readable label for every known format", () => {
    for (const { value, label } of SCORING_FORMATS) {
      expect(formatLabel(value)).toBe(label);
    }
  });

  it("labels the las_vegas format", () => {
    expect(formatLabel("las_vegas")).toBe("Las Vegas");
  });

  it("labels the best_ball format", () => {
    expect(formatLabel("best_ball")).toBe("Best Ball");
  });

  it("falls back to the raw value for an unknown format", () => {
    expect(formatLabel("future_format")).toBe("future_format");
  });

  it("falls back to empty string for an empty value", () => {
    expect(formatLabel("")).toBe("");
  });
});

describe("formatToPar", () => {
  it("returns '—' for null", () => {
    expect(formatToPar(null)).toBe("—");
  });

  it("returns 'E' for even par", () => {
    expect(formatToPar(0)).toBe("E");
  });

  it("returns '+N' for a positive value", () => {
    expect(formatToPar(1)).toBe("+1");
    expect(formatToPar(5)).toBe("+5");
    expect(formatToPar(10)).toBe("+10");
  });

  it("returns '-N' for a negative value", () => {
    expect(formatToPar(-1)).toBe("-1");
    expect(formatToPar(-3)).toBe("-3");
    expect(formatToPar(-10)).toBe("-10");
  });
});
