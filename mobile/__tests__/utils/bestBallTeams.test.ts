// __tests__/utils/bestBallTeams.test.ts
// Unit tests for the free-form N-team assignment helpers in utils/bestBallTeams.ts.
// Covers group filtering, seeding from existing teams, partitioning, counts, and the
// "≥2 non-empty teams" validation (no equal-size rule).

import {
  teamsForGroup,
  seedAssignment,
  partitionAssignment,
  teamCounts,
  nonEmptyTeams,
  isValidBestBallPartition,
  type BestBallTeamSummary,
} from "@/utils/bestBallTeams";

const teams: BestBallTeamSummary[] = [
  { id: "T1", name: "Team 1", roundPlayerIds: ["rp1", "rp2"] },
  { id: "T2", name: "Team 2", roundPlayerIds: ["rp3", "rp4"] },
  { id: "T3", name: "Other group", roundPlayerIds: ["rp9"] },
];

describe("teamsForGroup", () => {
  it("returns only teams with a member in the group", () => {
    const result = teamsForGroup(["rp1", "rp2", "rp3", "rp4"], teams);
    expect(result.map((t) => t.id)).toEqual(["T1", "T2"]);
  });
});

describe("seedAssignment", () => {
  it("maps each team's members to its index and floors team count at 2", () => {
    const { assignment, teamCount } = seedAssignment(
      ["rp1", "rp2", "rp3", "rp4"],
      [teams[0], teams[1]],
    );
    expect(assignment).toEqual({ rp1: 0, rp2: 0, rp3: 1, rp4: 1 });
    expect(teamCount).toBe(2);
  });

  it("shows two empty slots when no teams exist yet", () => {
    const { assignment, teamCount } = seedAssignment(["rp1", "rp2"], []);
    expect(assignment).toEqual({});
    expect(teamCount).toBe(2);
  });

  it("supports more than two teams", () => {
    const four: BestBallTeamSummary[] = [
      { id: "A", name: "A", roundPlayerIds: ["rp1"] },
      { id: "B", name: "B", roundPlayerIds: ["rp2"] },
      { id: "C", name: "C", roundPlayerIds: ["rp3"] },
      { id: "D", name: "D", roundPlayerIds: ["rp4"] },
    ];
    const { assignment, teamCount } = seedAssignment(["rp1", "rp2", "rp3", "rp4"], four);
    expect(teamCount).toBe(4);
    expect(assignment).toEqual({ rp1: 0, rp2: 1, rp3: 2, rp4: 3 });
  });

  it("ignores members outside the group", () => {
    const { assignment } = seedAssignment(["rp1"], [{ id: "T1", name: "T1", roundPlayerIds: ["rp1", "rp2"] }]);
    expect(assignment).toEqual({ rp1: 0 });
  });
});

describe("partitionAssignment", () => {
  it("splits into teamCount member lists", () => {
    const parts = partitionAssignment({ rp1: 0, rp2: 0, rp3: 1, rp4: 2 }, 3);
    expect(parts).toEqual([["rp1", "rp2"], ["rp3"], ["rp4"]]);
  });
  it("ignores out-of-range indexes", () => {
    expect(partitionAssignment({ rp1: 0, rp2: 5 }, 2)).toEqual([["rp1"], []]);
  });
});

describe("teamCounts", () => {
  it("counts members per slot", () => {
    expect(teamCounts({ rp1: 0, rp2: 0, rp3: 1 }, 3)).toEqual([2, 1, 0]);
  });
});

describe("nonEmptyTeams", () => {
  it("drops empty slots", () => {
    expect(nonEmptyTeams({ rp1: 0, rp2: 2 }, 3)).toEqual([["rp1"], ["rp2"]]);
  });
});

describe("isValidBestBallPartition", () => {
  it("is valid with two or more non-empty teams of any size", () => {
    expect(isValidBestBallPartition({ rp1: 0, rp2: 0, rp3: 1 }, 2)).toBe(true); // 2 vs 1
    expect(isValidBestBallPartition({ rp1: 0, rp2: 1, rp3: 2 }, 3)).toBe(true);
  });
  it("is invalid with fewer than two non-empty teams", () => {
    expect(isValidBestBallPartition({ rp1: 0, rp2: 0 }, 2)).toBe(false); // all on one team
    expect(isValidBestBallPartition({}, 2)).toBe(false);
  });
});
