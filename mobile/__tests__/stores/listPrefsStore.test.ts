// __tests__/stores/listPrefsStore.test.ts
// Tests the list-prefs store's defaults, patch setters, and filter resets.
// Persistence (SecureStore I/O) is zustand's job — here we mock storage to
// return empty so the boot read yields defaults, then exercise the reducers.

// Boot read calls SecureStore.getItem synchronously at import time — mock it to
// return null so the store starts from defaults.
jest.mock("expo-secure-store", () => ({
  getItem: jest.fn(() => null),
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

import {
  useListPrefsStore,
  EVENT_PREFS_DEFAULT,
  ROUND_PREFS_DEFAULT,
} from "@/stores/listPrefsStore";

// Reset to defaults before each test so cases don't bleed into each other.
beforeEach(() => {
  useListPrefsStore.setState({
    events: { ...EVENT_PREFS_DEFAULT },
    rounds: { ...ROUND_PREFS_DEFAULT },
  });
});

describe("listPrefsStore defaults", () => {
  it("starts with the documented event defaults (status 'active')", () => {
    expect(useListPrefsStore.getState().events).toEqual(EVENT_PREFS_DEFAULT);
    expect(EVENT_PREFS_DEFAULT.statusFilter).toBe("active");
  });

  it("starts with the documented round defaults (all statuses, newest first)", () => {
    expect(useListPrefsStore.getState().rounds).toEqual(ROUND_PREFS_DEFAULT);
    expect(ROUND_PREFS_DEFAULT.sortKey).toBe("date_desc");
  });
});

describe("setEventPrefs", () => {
  it("merges a single axis without clobbering the others", () => {
    useListPrefsStore.getState().setEventPrefs({ typeFilter: "tournament" });
    const { events } = useListPrefsStore.getState();
    expect(events.typeFilter).toBe("tournament");
    expect(events.statusFilter).toBe("active"); // unchanged
    expect(events.sortKey).toBe("start_date_asc"); // unchanged
  });
});

describe("setRoundPrefs", () => {
  it("merges a single axis without clobbering the others", () => {
    useListPrefsStore.getState().setRoundPrefs({ sortKey: "name_asc" });
    const { rounds } = useListPrefsStore.getState();
    expect(rounds.sortKey).toBe("name_asc");
    expect(rounds.statusFilter).toBe("all"); // unchanged
    expect(rounds.formatFilter).toBe("all"); // unchanged
  });
});

describe("resetEventFilters", () => {
  it("resets filters to defaults but keeps the chosen sort", () => {
    useListPrefsStore.getState().setEventPrefs({
      typeFilter: "casual",
      statusFilter: "completed",
      sortKey: "name_asc",
    });
    useListPrefsStore.getState().resetEventFilters();
    const { events } = useListPrefsStore.getState();
    expect(events.typeFilter).toBe("all");
    expect(events.statusFilter).toBe("active");
    expect(events.sortKey).toBe("name_asc"); // sort preserved
  });
});

describe("resetRoundFilters", () => {
  it("resets filters to defaults but keeps the chosen sort", () => {
    useListPrefsStore.getState().setRoundPrefs({
      statusFilter: "completed",
      formatFilter: "best_ball",
      sortKey: "course_asc",
    });
    useListPrefsStore.getState().resetRoundFilters();
    const { rounds } = useListPrefsStore.getState();
    expect(rounds.statusFilter).toBe("all");
    expect(rounds.formatFilter).toBe("all");
    expect(rounds.sortKey).toBe("course_asc"); // sort preserved
  });
});
