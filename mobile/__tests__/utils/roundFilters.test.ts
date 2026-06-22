// __tests__/utils/roundFilters.test.ts
// Unit tests for filterRounds() and sortRounds() in utils/roundFilters.ts.

import { filterRounds, sortRounds, FilterableRound } from "@/utils/roundFilters";

// Helper to build a minimal round with overrides.
function rd(over: Partial<FilterableRound>): FilterableRound {
  return {
    status: "active",
    scoring_format: "stroke",
    scheduled_date: "2026-01-01",
    name: "Round",
    course_name: "Pebble Beach",
    ...over,
  };
}

describe("filterRounds", () => {
  const rounds = [
    rd({ status: "active", scoring_format: "stroke", name: "A" }),
    rd({ status: "scheduled", scoring_format: "best_ball", name: "B" }),
    rd({ status: "completed", scoring_format: "stroke", name: "C" }),
  ];

  it("returns all rounds when both filters are 'all'", () => {
    expect(filterRounds(rounds, "all", "all")).toHaveLength(3);
  });

  it("filters by status", () => {
    expect(filterRounds(rounds, "scheduled", "all").map((r) => r.name)).toEqual(["B"]);
  });

  it("filters by scoring format", () => {
    expect(filterRounds(rounds, "all", "stroke").map((r) => r.name)).toEqual(["A", "C"]);
  });

  it("applies status and format together", () => {
    expect(filterRounds(rounds, "completed", "best_ball")).toHaveLength(0);
    expect(filterRounds(rounds, "completed", "stroke").map((r) => r.name)).toEqual(["C"]);
  });

  it("does not mutate the input array", () => {
    const input = [...rounds];
    filterRounds(input, "active", "stroke");
    expect(input).toHaveLength(3);
  });
});

describe("sortRounds", () => {
  it("sorts by date descending (latest first) — the default order", () => {
    const input = [
      rd({ name: "mid", scheduled_date: "2026-03-01" }),
      rd({ name: "late", scheduled_date: "2026-06-01" }),
      rd({ name: "early", scheduled_date: "2026-01-01" }),
    ];
    expect(sortRounds(input, "date_desc").map((r) => r.name)).toEqual(["late", "mid", "early"]);
  });

  it("sorts by date ascending (earliest first)", () => {
    const input = [
      rd({ name: "late", scheduled_date: "2026-06-01" }),
      rd({ name: "early", scheduled_date: "2026-01-01" }),
    ];
    expect(sortRounds(input, "date_asc").map((r) => r.name)).toEqual(["early", "late"]);
  });

  it("sorts by name A–Z", () => {
    const input = [rd({ name: "Charlie" }), rd({ name: "alpha" }), rd({ name: "Bravo" })];
    expect(sortRounds(input, "name_asc").map((r) => r.name)).toEqual(["alpha", "Bravo", "Charlie"]);
  });

  it("sorts by course name A–Z", () => {
    const input = [
      rd({ name: "x", course_name: "Torrey Pines" }),
      rd({ name: "y", course_name: "Augusta National" }),
      rd({ name: "z", course_name: "Pebble Beach" }),
    ];
    expect(sortRounds(input, "course_asc").map((r) => r.name)).toEqual(["y", "z", "x"]);
  });

  it("returns a new array and does not mutate the input", () => {
    const input = [rd({ name: "B" }), rd({ name: "A" })];
    const result = sortRounds(input, "name_asc");
    expect(result).not.toBe(input);
    expect(input.map((r) => r.name)).toEqual(["B", "A"]); // original untouched
  });
});
