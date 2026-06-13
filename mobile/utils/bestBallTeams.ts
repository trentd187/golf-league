// utils/bestBallTeams.ts
// Pure helpers for the organizer's Best Ball team-assignment UI. Unlike Vegas
// (fixed two sides), Best Ball is free-form: any number of teams of any size that
// partition one playing group. The editor models the assignment as
// round_player_id → teamIndex (0-based); these helpers seed it from existing teams,
// partition it into per-team member lists, count members, and validate it. The
// actual create/assign/delete API calls live in the modal — this only shapes data.

// BestBallTeamSummary mirrors one team + its members from GET /rounds/:id/teams.
export interface BestBallTeamSummary {
  id: string;
  name: string;
  roundPlayerIds: string[];
}

// teamsForGroup returns the teams whose members all belong to the given group.
// Teams belong to a round (not a group) in the data model, so a team counts for the
// group when it has at least one member among the group's round_player_ids.
export function teamsForGroup(groupRoundPlayerIds: string[], teams: BestBallTeamSummary[]): BestBallTeamSummary[] {
  const ids = new Set(groupRoundPlayerIds);
  return teams.filter((tm) => tm.roundPlayerIds.some((rp) => ids.has(rp)));
}

// SeedResult is the editor's starting state derived from existing teams: the
// round_player_id → teamIndex map plus how many team slots to render (at least 2).
export interface SeedResult {
  assignment: Record<string, number>;
  teamCount: number;
}

// seedAssignment derives the editor state from the group's existing teams: members of
// the first team → index 0, second → 1, and so on. Players not yet on a team are
// omitted (unassigned). teamCount is the number of existing teams, floored at 2 so the
// organizer always sees at least two slots to fill.
export function seedAssignment(
  groupRoundPlayerIds: string[],
  groupTeams: BestBallTeamSummary[],
): SeedResult {
  const assignment: Record<string, number> = {};
  const ids = new Set(groupRoundPlayerIds);
  groupTeams.forEach((tm, idx) => {
    for (const rp of tm.roundPlayerIds) {
      if (ids.has(rp)) assignment[rp] = idx;
    }
  });
  return { assignment, teamCount: Math.max(2, groupTeams.length) };
}

// partitionAssignment splits the assignment into teamCount member lists (index i holds
// the round_player_ids assigned to team i). Out-of-range indexes are ignored.
export function partitionAssignment(assignment: Record<string, number>, teamCount: number): string[][] {
  const teams: string[][] = Array.from({ length: teamCount }, () => []);
  for (const [rpId, idx] of Object.entries(assignment)) {
    if (idx >= 0 && idx < teamCount) teams[idx].push(rpId);
  }
  return teams;
}

// teamCounts returns the number of members on each team slot.
export function teamCounts(assignment: Record<string, number>, teamCount: number): number[] {
  return partitionAssignment(assignment, teamCount).map((t) => t.length);
}

// nonEmptyTeams returns only the team slots that have at least one member (these are
// the teams that will actually be saved — empty trailing slots are dropped).
export function nonEmptyTeams(assignment: Record<string, number>, teamCount: number): string[][] {
  return partitionAssignment(assignment, teamCount).filter((t) => t.length > 0);
}

// isValidBestBallPartition reports whether the assignment forms a savable match: at
// least two non-empty teams. There is no equal-size rule — any sizes are allowed.
export function isValidBestBallPartition(assignment: Record<string, number>, teamCount: number): boolean {
  return nonEmptyTeams(assignment, teamCount).length >= 2;
}
