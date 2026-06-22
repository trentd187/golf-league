// __tests__/utils/eventFilters.test.ts
// Unit tests for filterEvents() and sortEvents() in utils/eventFilters.ts.

import { filterEvents, sortEvents, FilterableEvent } from "@/utils/eventFilters";

// Helper to build a minimal event with overrides.
function ev(over: Partial<FilterableEvent>): FilterableEvent {
  return {
    event_type: "league",
    status: "active",
    start_date: "2026-01-01",
    name: "Event",
    member_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("filterEvents", () => {
  const events = [
    ev({ event_type: "league", status: "active", name: "A" }),
    ev({ event_type: "tournament", status: "completed", name: "B" }),
    ev({ event_type: "casual", status: "active", name: "C" }),
  ];

  it("returns all events when both filters are 'all'", () => {
    expect(filterEvents(events, "all", "all")).toHaveLength(3);
  });

  it("filters by type", () => {
    const result = filterEvents(events, "tournament", "all");
    expect(result.map((e) => e.name)).toEqual(["B"]);
  });

  it("filters by status", () => {
    const result = filterEvents(events, "all", "active");
    expect(result.map((e) => e.name)).toEqual(["A", "C"]);
  });

  it("applies type and status together", () => {
    expect(filterEvents(events, "casual", "completed")).toHaveLength(0);
    expect(filterEvents(events, "casual", "active").map((e) => e.name)).toEqual(["C"]);
  });

  it("does not mutate the input array", () => {
    const input = [...events];
    filterEvents(input, "league", "active");
    expect(input).toHaveLength(3);
  });
});

describe("sortEvents", () => {
  it("sorts by start_date ascending with nulls last", () => {
    const input = [
      ev({ name: "later", start_date: "2026-03-01" }),
      ev({ name: "nodate", start_date: null }),
      ev({ name: "earlier", start_date: "2026-01-01" }),
    ];
    expect(sortEvents(input, "start_date_asc").map((e) => e.name)).toEqual([
      "earlier",
      "later",
      "nodate",
    ]);
  });

  it("sorts by start_date descending with nulls still last", () => {
    const input = [
      ev({ name: "earlier", start_date: "2026-01-01" }),
      ev({ name: "nodate", start_date: null }),
      ev({ name: "later", start_date: "2026-03-01" }),
    ];
    expect(sortEvents(input, "start_date_desc").map((e) => e.name)).toEqual([
      "later",
      "earlier",
      "nodate",
    ]);
  });

  it("keeps order stable when both start dates are null", () => {
    const input = [ev({ name: "x", start_date: null }), ev({ name: "y", start_date: null })];
    expect(sortEvents(input, "start_date_asc").map((e) => e.name)).toEqual(["x", "y"]);
  });

  it("sorts by name A–Z", () => {
    const input = [ev({ name: "Charlie" }), ev({ name: "alpha" }), ev({ name: "Bravo" })];
    // localeCompare is case-insensitive-ish: a < B < C
    expect(sortEvents(input, "name_asc").map((e) => e.name)).toEqual(["alpha", "Bravo", "Charlie"]);
  });

  it("sorts by member_count descending", () => {
    const input = [
      ev({ name: "small", member_count: 2 }),
      ev({ name: "big", member_count: 10 }),
      ev({ name: "mid", member_count: 5 }),
    ];
    expect(sortEvents(input, "members_desc").map((e) => e.name)).toEqual(["big", "mid", "small"]);
  });

  it("sorts by created_at descending (newest first)", () => {
    const input = [
      ev({ name: "old", created_at: "2026-01-01T00:00:00Z" }),
      ev({ name: "new", created_at: "2026-06-01T00:00:00Z" }),
    ];
    expect(sortEvents(input, "created_desc").map((e) => e.name)).toEqual(["new", "old"]);
  });

  it("returns a new array and does not mutate the input", () => {
    const input = [ev({ name: "B" }), ev({ name: "A" })];
    const result = sortEvents(input, "name_asc");
    expect(result).not.toBe(input);
    expect(input.map((e) => e.name)).toEqual(["B", "A"]); // original untouched
  });
});
