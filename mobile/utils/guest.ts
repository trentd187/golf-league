// utils/guest.ts
// Pure input helpers for adding a score-only guest player to a round group.
// Kept React-free so the AddGuestModal stays logic-free and these can be
// unit-tested in isolation (the screen file is excluded from coverage).

import { parseCourseHandicapInput } from "@/utils/handicap";

// Max guest display-name length — mirrors the backend AddGuestToGroup validation.
export const GUEST_NAME_MAX_LENGTH = 80;

// GuestNameResult is the outcome of validating a raw guest-name input.
export type GuestNameResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

// validateGuestName trims the input and rejects blank or over-long names.
// Returns the cleaned name on success so callers send the trimmed value.
export function validateGuestName(raw: string): GuestNameResult {
  const value = raw.trim();
  if (value === "") {
    return { ok: false, error: "Name is required" };
  }
  if (value.length > GUEST_NAME_MAX_LENGTH) {
    return { ok: false, error: `Name must be ${GUEST_NAME_MAX_LENGTH} characters or fewer` };
  }
  return { ok: true, value };
}

// parseGuestHandicap converts a raw handicap input to the value the API expects,
// using the same golf notation as registered players: "+2" → a plus handicap
// (stored -2), "12" → 12, "0" → scratch. Empty/whitespace or anything invalid →
// null (guest plays gross / a typo never blocks adding them; the organizer can edit
// the handicap afterward). Delegates to the shared parser so the two entry paths
// can never diverge on the sign convention.
export function parseGuestHandicap(raw: string): number | null {
  return parseCourseHandicapInput(raw);
}
