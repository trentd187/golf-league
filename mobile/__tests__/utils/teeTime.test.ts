// __tests__/utils/teeTime.test.ts
// Unit tests for the pure tee-time conversion helpers used by TimeInput and the
// event/round detail screens.

import {
  teeTimeToDate,
  dateToTeeTime,
  formatTeeTime,
  parseFormattedTeeTime,
} from "@/utils/teeTime";

describe("teeTimeToDate / dateToTeeTime round-trip", () => {
  it("round-trips a morning time", () => {
    expect(dateToTeeTime(teeTimeToDate("07:30"))).toBe("07:30");
  });

  it("round-trips an afternoon time", () => {
    expect(dateToTeeTime(teeTimeToDate("13:05"))).toBe("13:05");
  });

  it("zero-pads single-digit hours and minutes", () => {
    const d = new Date();
    d.setHours(7, 5, 0, 0);
    expect(dateToTeeTime(d)).toBe("07:05");
  });

  it("returns a Date for empty input (falls back to now, no crash)", () => {
    expect(teeTimeToDate("")).toBeInstanceOf(Date);
  });

  it("leaves the Date unchanged for malformed input", () => {
    // No throw and a valid Date back even when the string can't be parsed.
    expect(teeTimeToDate("not-a-time")).toBeInstanceOf(Date);
  });
});

describe("formatTeeTime ('HH:MM' → 'h:mm AM/PM')", () => {
  it("formats a morning time", () => {
    expect(formatTeeTime("07:30")).toBe("7:30 AM");
  });

  it("formats an afternoon time", () => {
    expect(formatTeeTime("13:05")).toBe("1:05 PM");
  });

  it("formats noon as 12 PM", () => {
    expect(formatTeeTime("12:00")).toBe("12:00 PM");
  });

  it("formats midnight as 12 AM", () => {
    expect(formatTeeTime("00:00")).toBe("12:00 AM");
  });

  it("returns empty string for empty input", () => {
    expect(formatTeeTime("")).toBe("");
  });

  it("echoes back unparseable input unchanged", () => {
    expect(formatTeeTime("garbage")).toBe("garbage");
  });
});

describe("parseFormattedTeeTime ('h:mm AM/PM' → 'HH:MM')", () => {
  it("parses a morning time", () => {
    expect(parseFormattedTeeTime("7:30 AM")).toBe("07:30");
  });

  it("parses an afternoon time", () => {
    expect(parseFormattedTeeTime("1:05 PM")).toBe("13:05");
  });

  it("parses noon (12 PM → 12)", () => {
    expect(parseFormattedTeeTime("12:00 PM")).toBe("12:00");
  });

  it("parses midnight (12 AM → 00)", () => {
    expect(parseFormattedTeeTime("12:00 AM")).toBe("00:00");
  });

  it("is the inverse of formatTeeTime", () => {
    expect(parseFormattedTeeTime(formatTeeTime("16:45"))).toBe("16:45");
  });

  it("returns empty string for null/empty/invalid input", () => {
    expect(parseFormattedTeeTime(null)).toBe("");
    expect(parseFormattedTeeTime("")).toBe("");
    expect(parseFormattedTeeTime("13:05")).toBe(""); // missing AM/PM
    expect(parseFormattedTeeTime("nope")).toBe("");
  });
});
