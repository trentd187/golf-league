// utils/vegasTeams.ts
// Pure helpers for the organizer's Las Vegas partner-assignment UI. Keep the team
// bookkeeping (which players form which side, seeding the editor from existing teams)
// out of the screen so it can be unit-tested. The actual create/assign/delete calls
// live in the modal; these functions only shape the data.

// VegasTeamSummary mirrors the GET /rounds/:id/teams response (one team + its members).
export interface VegasTeamSummary {
  id: string;
  name: string;
  roundPlayerIds: string[];
}

// teamsForGroup returns the teams whose members all belong to the given group.
// Teams belong to a round (not a group) in the data model, so we associate a team
// with a group by membership: a team counts for the group when it has at least one
// member among the group's round_player_ids.
export function teamsForGroup(groupRoundPlayerIds: string[], teams: VegasTeamSummary[]): VegasTeamSummary[] {
  const ids = new Set(groupRoundPlayerIds);
  return teams.filter((tm) => tm.roundPlayerIds.some((rp) => ids.has(rp)));
}

// seedAssignment derives the editor's side map (round_player_id → 1 | 2) from the
// group's existing teams: members of the first team → side 1, second team → side 2.
// Players not yet on a team are omitted (unassigned).
export function seedAssignment(
  groupRoundPlayerIds: string[],
  groupTeams: VegasTeamSummary[],
): Record<string, 1 | 2> {
  const out: Record<string, 1 | 2> = {};
  const ids = new Set(groupRoundPlayerIds);
  groupTeams.slice(0, 2).forEach((tm, idx) => {
    const side: 1 | 2 = idx === 0 ? 1 : 2;
    for (const rp of tm.roundPlayerIds) {
      if (ids.has(rp)) out[rp] = side;
    }
  });
  return out;
}

// partitionAssignment splits a side map into the two teams' member lists.
export function partitionAssignment(assignment: Record<string, 1 | 2>): { team1: string[]; team2: string[] } {
  const team1: string[] = [];
  const team2: string[] = [];
  for (const [rpId, side] of Object.entries(assignment)) {
    (side === 1 ? team1 : team2).push(rpId);
  }
  return { team1, team2 };
}

// isCompleteVegasPartition reports whether the assignment forms a valid 2v2 match:
// exactly two players on each side. Partial assignments are allowed to save (the
// matchup just won't render until both sides have two), but this gates the
// "ready" affordance and prevents saving more than two per side.
export function isCompleteVegasPartition(assignment: Record<string, 1 | 2>): boolean {
  const { team1, team2 } = partitionAssignment(assignment);
  return team1.length === 2 && team2.length === 2;
}

// sideCounts returns how many players are on each side — used to cap selection at 2.
export function sideCounts(assignment: Record<string, 1 | 2>): { team1: number; team2: number } {
  const { team1, team2 } = partitionAssignment(assignment);
  return { team1: team1.length, team2: team2.length };
}
