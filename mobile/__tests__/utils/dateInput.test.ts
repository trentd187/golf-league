// __tests__/utils/dateInput.test.ts
// Unit tests for the pure date helpers shared by the native and web DateInput components.

import {
  apiToDisplay,
  displayToApi,
  isValidDisplayDate,
  autoFormat,
} from "@/utils/dateInput";

describe("apiToDisplay (YYYY-MM-DD → MM-DD-YY)", () => {
  it("converts a valid ISO date", () => {
    expect(apiToDisplay("2026-05-14")).toBe("05-14-26");
  });

  it("returns empty string for null/undefined/empty", () => {
    expect(apiToDisplay(null)).toBe("");
    expect(apiToDisplay(undefined)).toBe("");
    expect(apiToDisplay("")).toBe("");
  });

  it("returns empty string for a malformed ISO date", () => {
    expect(apiToDisplay("2026/05/14")).toBe("");
  });
});

describe("displayToApi (MM-DD-YY → YYYY-MM-DD)", () => {
  it("converts a valid display date", () => {
    expect(displayToApi("05-14-26")).toBe("2026-05-14");
  });

  it("returns empty string for empty input", () => {
    expect(displayToApi("")).toBe("");
  });

  it("returns empty string for incomplete input", () => {
    expect(displayToApi("05-14")).toBe("");
  });

  it("round-trips with apiToDisplay", () => {
    expect(displayToApi(apiToDisplay("2026-11-02"))).toBe("2026-11-02");
  });
});

describe("isValidDisplayDate", () => {
  it("accepts a valid full date", () => {
    expect(isValidDisplayDate("05-14-26")).toBe(true);
  });

  it("rejects partial input (still typing)", () => {
    expect(isValidDisplayDate("05-1")).toBe(false);
    expect(isValidDisplayDate("05-14-2")).toBe(false);
  });

  it("rejects an out-of-range month", () => {
    expect(isValidDisplayDate("13-01-26")).toBe(false);
  });

  it("rejects an out-of-range day", () => {
    expect(isValidDisplayDate("01-32-26")).toBe(false);
  });

  it("rejects an impossible calendar date (Feb 30)", () => {
    expect(isValidDisplayDate("02-30-26")).toBe(false);
  });

  it("accepts a leap-day in a leap year", () => {
    expect(isValidDisplayDate("02-29-24")).toBe(true);
  });
});

describe("autoFormat (insert dashes as the user types)", () => {
  it("leaves 1–2 digits unchanged", () => {
    expect(autoFormat("0")).toBe("0");
    expect(autoFormat("03")).toBe("03");
  });

  it("inserts the first dash after the month", () => {
    expect(autoFormat("0301")).toBe("03-01");
  });

  it("inserts both dashes for a full date", () => {
    expect(autoFormat("030126")).toBe("03-01-26");
  });

  it("strips non-digits and caps at 6 digits", () => {
    expect(autoFormat("03/01/2026")).toBe("03-01-20");
  });
});
