// __tests__/utils/vegasTeams.test.ts
// Unit tests for the pure partner-assignment helpers in utils/vegasTeams.ts.

import {
  teamsForGroup,
  seedAssignment,
  partitionAssignment,
  isCompleteVegasPartition,
  sideCounts,
  type VegasTeamSummary,
} from "@/utils/vegasTeams";

const teams: VegasTeamSummary[] = [
  { id: "t1", name: "Team 1", roundPlayerIds: ["rp1", "rp2"] },
  { id: "t2", name: "Team 2", roundPlayerIds: ["rp3", "rp4"] },
  { id: "t3", name: "Other Group", roundPlayerIds: ["rp9"] },
];

describe("teamsForGroup", () => {
  it("returns only teams with a member in the group", () => {
    const result = teamsForGroup(["rp1", "rp2", "rp3", "rp4"], teams);
    expect(result.map((t) => t.id)).toEqual(["t1", "t2"]);
  });
  it("excludes teams from other groups", () => {
    expect(teamsForGroup(["rp1"], teams).map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("seedAssignment", () => {
  it("maps first team to side 1 and second to side 2", () => {
    const seed = seedAssignment(["rp1", "rp2", "rp3", "rp4"], teams.slice(0, 2));
    expect(seed).toEqual({ rp1: 1, rp2: 1, rp3: 2, rp4: 2 });
  });
  it("omits players not in the group", () => {
    const seed = seedAssignment(["rp1"], teams.slice(0, 2));
    expect(seed).toEqual({ rp1: 1 });
  });
  it("returns empty when there are no teams yet", () => {
    expect(seedAssignment(["rp1", "rp2"], [])).toEqual({});
  });
});

describe("partitionAssignment", () => {
  it("splits the side map into two lists", () => {
    const { team1, team2 } = partitionAssignment({ rp1: 1, rp2: 1, rp3: 2 });
    expect(team1.sort()).toEqual(["rp1", "rp2"]);
    expect(team2).toEqual(["rp3"]);
  });
});

describe("isCompleteVegasPartition", () => {
  it("is true for exactly two on each side", () => {
    expect(isCompleteVegasPartition({ rp1: 1, rp2: 1, rp3: 2, rp4: 2 })).toBe(true);
  });
  it("is false for an unbalanced or partial split", () => {
    expect(isCompleteVegasPartition({ rp1: 1, rp2: 1, rp3: 2 })).toBe(false);
    expect(isCompleteVegasPartition({ rp1: 1, rp2: 2 })).toBe(false);
  });
});

describe("sideCounts", () => {
  it("counts players per side", () => {
    expect(sideCounts({ rp1: 1, rp2: 1, rp3: 2 })).toEqual({ team1: 2, team2: 1 });
  });
});
