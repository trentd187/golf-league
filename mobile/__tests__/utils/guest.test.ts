// __tests__/utils/guest.test.ts
// Unit tests for the pure guest-input helpers used by AddGuestModal.

import {
  GUEST_NAME_MAX_LENGTH,
  parseGuestHandicap,
  validateGuestName,
} from "@/utils/guest";

describe("validateGuestName", () => {
  it("trims and accepts a normal name", () => {
    expect(validateGuestName("  Sandbagger Sam  ")).toEqual({
      ok: true,
      value: "Sandbagger Sam",
    });
  });

  it("rejects an empty string", () => {
    expect(validateGuestName("")).toEqual({ ok: false, error: "Name is required" });
  });

  it("rejects a whitespace-only string", () => {
    expect(validateGuestName("   ")).toEqual({ ok: false, error: "Name is required" });
  });

  it("accepts a name exactly at the max length", () => {
    const name = "a".repeat(GUEST_NAME_MAX_LENGTH);
    expect(validateGuestName(name)).toEqual({ ok: true, value: name });
  });

  it("rejects a name over the max length", () => {
    const name = "a".repeat(GUEST_NAME_MAX_LENGTH + 1);
    const result = validateGuestName(name);
    expect(result.ok).toBe(false);
  });
});

describe("parseGuestHandicap", () => {
  it("returns null for empty input", () => {
    expect(parseGuestHandicap("")).toBeNull();
    expect(parseGuestHandicap("   ")).toBeNull();
  });

  it("parses a positive integer", () => {
    expect(parseGuestHandicap("12")).toBe(12);
    expect(parseGuestHandicap("  8 ")).toBe(8);
  });

  it("parses a plus-handicap (negative)", () => {
    expect(parseGuestHandicap("-2")).toBe(-2);
  });

  it("parses zero", () => {
    expect(parseGuestHandicap("0")).toBe(0);
  });

  it("returns null for decimals and non-numeric input", () => {
    expect(parseGuestHandicap("10.5")).toBeNull();
    expect(parseGuestHandicap("abc")).toBeNull();
    expect(parseGuestHandicap("1a")).toBeNull();
  });
});
