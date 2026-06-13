// utils/bestBall.ts
// Pure calculation helpers for the Best Ball team game. Kept React-free so they can
// be unit-tested in isolation and reused by both the editable Basic Best Ball
// scorecard (live, from local score state) and the read-only Teams tabs (from the
// server scorecard). Nothing here persists — best-ball results are always derived.
//
// Rules implemented:
//   - Every player plays their own ball the whole hole; a team's score for the hole
//     is the LOWEST of its members' scores (gross or net per the round's basis).
//   - A team's round total is the sum of its per-hole best scores over scored holes.
//   - Teams are ranked by cumulative total, LOWEST wins. Any number of teams of any
//     size is supported (2v2, 4v4, 2v2v2v2, …) — teams partition one playing group.

import type { Scorecard, ScorecardGroup, ScorecardHole } from "@/types/scorecard";
import { holeHandicapStrokes, normalizeStrokeIndexes } from "@/utils/handicap";

export type BestBallBasis = "gross" | "net";

// BestBallTeamInfo describes one team in a group match.
export interface BestBallTeamInfo {
  teamId: string;
  name: string;
  roundPlayerIds: string[];
  userIds: string[];
  playerNames: string[];
}

// BestBallTeamHole is one team's outcome on one hole.
export interface BestBallTeamHole {
  teamId: string;
  best: number | null; // lowest member score (gross/net per basis); null = none entered
  ownerRoundPlayerId: string | null; // which member owns the counting score
  complete: boolean; // at least one member scored the hole
  runningTotal: number; // cumulative best for this team through this hole
}

// BestBallHoleResult is the per-team breakdown for a single hole.
export interface BestBallHoleResult {
  holeNumber: number;
  par: number | null;
  teams: BestBallTeamHole[]; // one per team, same order as match.teams
}

// BestBallTeamStanding is a team's leaderboard line (lowest total ranks first).
export interface BestBallTeamStanding {
  teamId: string;
  name: string;
  playerNames: string[];
  total: number; // cumulative best-ball total over scored holes
  holesCounted: number; // how many holes contributed to the total
  rank: number; // 1 = lowest total (best); teams with equal totals share a rank
}

// BestBallRoundMatch is the full set of teams + per-hole results + standings for one group.
export interface BestBallRoundMatch {
  groupId: string;
  groupNumber: number;
  teams: BestBallTeamInfo[];
  holes: BestBallHoleResult[];
  standings: BestBallTeamStanding[]; // sorted ascending by total (best first)
  complete: boolean; // every team has a best on every hole
}

// BestBallEventRoundDetail is one player's team result in one Best Ball round.
export interface BestBallEventRoundDetail {
  roundId: string;
  roundName: string;
  teamName: string;
  teammateNames: string[];
  total: number;
  rank: number;
  won: boolean;
}

// BestBallEventPlayerTally is a player's cumulative Best Ball standing across an event.
// Teams re-form each round, so the event tally aggregates per player (like Vegas),
// crediting each member with their team's per-round result.
export interface BestBallEventPlayerTally {
  userId: string;
  displayName: string;
  roundsPlayed: number;
  wins: number; // rounds where the player's team finished rank 1 (ties count)
  totalStrokes: number; // sum of the player's team totals across rounds (lower is better)
  perRound: BestBallEventRoundDetail[];
}

// teamBestScorePick is the winning (lowest) score for a team on a hole and its owner.
export interface BestScorePick {
  best: number | null;
  ownerRoundPlayerId: string | null;
}

// teamBestScore returns the lowest non-null member value and the round_player_id that
// owns it. Ties keep the first member in input order. Returns nulls when no member scored.
export function teamBestScore(entries: { roundPlayerId: string; value: number | null }[]): BestScorePick {
  let best: number | null = null;
  let ownerRoundPlayerId: string | null = null;
  for (const e of entries) {
    if (e.value === null) continue;
    if (best === null || e.value < best) {
      best = e.value;
      ownerRoundPlayerId = e.roundPlayerId;
    }
  }
  return { best, ownerRoundPlayerId };
}

// scoreValue reads a player's score for a hole by basis, or null if not entered.
function scoreValue(
  player: ScorecardGroup["players"][number],
  holeNumber: number,
  basis: BestBallBasis,
): number | null {
  const s = player.scores.find((sc) => sc.hole_number === holeNumber);
  if (!s) return null;
  return basis === "net" ? s.net_score : s.gross_score;
}

// collectTeams gathers the distinct teams in a group (players carry team_id/team_name),
// in a stable order (by name, then id) so leaderboard order is deterministic.
function collectTeams(group: ScorecardGroup): BestBallTeamInfo[] {
  const byId = new Map<string, BestBallTeamInfo>();
  for (const p of group.players) {
    if (!p.team_id) continue;
    let team = byId.get(p.team_id);
    if (!team) {
      team = { teamId: p.team_id, name: p.team_name ?? "Team", roundPlayerIds: [], userIds: [], playerNames: [] };
      byId.set(p.team_id, team);
    }
    team.roundPlayerIds.push(p.round_player_id);
    team.userIds.push(p.user_id);
    team.playerNames.push(p.display_name);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.teamId.localeCompare(b.teamId));
}

// buildStandings ranks teams ascending by total (lowest best-ball total wins). Teams
// with equal totals share a rank. holesCounted is a display/secondary sort field.
function buildStandings(
  teams: BestBallTeamInfo[],
  totals: Record<string, number>,
  holesCounted: Record<string, number>,
): BestBallTeamStanding[] {
  const rows: BestBallTeamStanding[] = teams.map((t) => ({
    teamId: t.teamId,
    name: t.name,
    playerNames: t.playerNames,
    total: totals[t.teamId],
    holesCounted: holesCounted[t.teamId],
    rank: 0,
  }));
  rows.sort(
    (a, b) => a.total - b.total || b.holesCounted - a.holesCounted || a.name.localeCompare(b.name) || a.teamId.localeCompare(b.teamId),
  );
  // Teams with the same total share a rank; the next distinct total jumps to its index.
  let rank = 0;
  let prevTotal: number | null = null;
  rows.forEach((r, i) => {
    if (prevTotal === null || r.total !== prevTotal) {
      rank = i + 1;
      prevTotal = r.total;
    }
    r.rank = rank;
  });
  return rows;
}

// buildBestBallMatch builds the per-hole best-ball results and leaderboard for one
// group, or null when the group has fewer than two teams ("waiting for teams"). When
// perspectiveTeamId is given, that team is moved to the front of the teams list so the
// viewing player's team renders first.
export function buildBestBallMatch(
  group: ScorecardGroup,
  holes: ScorecardHole[],
  basis: BestBallBasis,
  perspectiveTeamId?: string,
): BestBallRoundMatch | null {
  let teams = collectTeams(group);
  if (teams.length < 2) return null;

  if (perspectiveTeamId) {
    const idx = teams.findIndex((t) => t.teamId === perspectiveTeamId);
    if (idx > 0) teams = [teams[idx], ...teams.slice(0, idx), ...teams.slice(idx + 1)];
  }

  const playersFor = (team: BestBallTeamInfo) => group.players.filter((p) => p.team_id === team.teamId);
  const running: Record<string, number> = {};
  const holesCounted: Record<string, number> = {};
  teams.forEach((t) => {
    running[t.teamId] = 0;
    holesCounted[t.teamId] = 0;
  });

  let allComplete = true;
  const holeResults: BestBallHoleResult[] = holes.map((h) => {
    const teamHoles: BestBallTeamHole[] = teams.map((team) => {
      const entries = playersFor(team).map((p) => ({
        roundPlayerId: p.round_player_id,
        value: scoreValue(p, h.hole_number, basis),
      }));
      const pick = teamBestScore(entries);
      if (pick.best === null) {
        allComplete = false;
      } else {
        running[team.teamId] += pick.best;
        holesCounted[team.teamId] += 1;
      }
      return {
        teamId: team.teamId,
        best: pick.best,
        ownerRoundPlayerId: pick.ownerRoundPlayerId,
        complete: pick.best !== null,
        runningTotal: running[team.teamId],
      };
    });
    return { holeNumber: h.hole_number, par: h.par || null, teams: teamHoles };
  });

  return {
    groupId: group.group_id,
    groupNumber: group.group_number,
    teams,
    holes: holeResults,
    standings: buildStandings(teams, running, holesCounted),
    complete: allComplete,
  };
}

// buildLiveBestBallMatch builds a match from live local gross-score input (rpId → hole →
// gross string) rather than the server scorecard, so the editable Basic Best Ball view
// updates as the user types. Net values are computed client-side from each player's
// effective handicap when the basis is net. Returns null when the group lacks two teams.
export function buildLiveBestBallMatch(
  group: ScorecardGroup,
  holes: ScorecardHole[],
  localGross: Record<string, Record<number, string>>,
  basis: BestBallBasis,
  effHandicaps: Record<string, number | null>,
  perspectiveTeamId?: string,
): BestBallRoundMatch | null {
  const siByHole = normalizeStrokeIndexes(holes);
  const holeCount = holes.length;

  const players = group.players.map((p) => {
    const scores: { hole_number: number; gross_score: number; net_score: number }[] = [];
    for (const h of holes) {
      const raw = localGross[p.round_player_id]?.[h.hole_number] ?? "";
      const g = parseInt(raw, 10);
      if (isNaN(g) || g < 1) continue;
      const eff = effHandicaps[p.round_player_id] ?? null;
      const net = eff !== null ? g - holeHandicapStrokes(eff, siByHole[h.hole_number], holeCount) : g;
      scores.push({ hole_number: h.hole_number, gross_score: g, net_score: net });
    }
    return { ...p, scores };
  });

  return buildBestBallMatch({ ...group, players }, holes, basis, perspectiveTeamId);
}

// bestBallBasisOf reads the round's basis off a scorecard, defaulting to gross.
export function bestBallBasisOf(sc: Scorecard): BestBallBasis {
  return sc.best_ball_scoring_basis === "net" ? "net" : "gross";
}

// buildBestBallRoundMatches builds a match for every group in the scorecard that has
// at least two teams. Groups with fewer than two teams are omitted (they show a
// waiting state upstream).
export function buildBestBallRoundMatches(sc: Scorecard): BestBallRoundMatch[] {
  const basis = bestBallBasisOf(sc);
  const out: BestBallRoundMatch[] = [];
  for (const group of sc.groups) {
    const match = buildBestBallMatch(group, sc.holes, basis);
    if (match) out.push(match);
  }
  return out;
}

// buildBestBallEventTally aggregates per-player Best Ball results across multiple
// scorecards. Non-best-ball scorecards and groups without two teams are skipped. Each
// member of a team is credited with that team's per-round total, rank, and win flag.
// Sorted by wins (most first), then fewest total strokes, then name.
export function buildBestBallEventTally(scorecards: Scorecard[]): BestBallEventPlayerTally[] {
  const byUser = new Map<string, BestBallEventPlayerTally>();

  for (const sc of scorecards) {
    if (sc.scoring_format !== "best_ball") continue;
    for (const match of buildBestBallRoundMatches(sc)) {
      const standingByTeam = new Map(match.standings.map((s) => [s.teamId, s]));
      for (const team of match.teams) {
        const standing = standingByTeam.get(team.teamId);
        if (!standing) continue;
        const won = standing.rank === 1;
        team.userIds.forEach((userId, idx) => {
          let tally = byUser.get(userId);
          if (!tally) {
            tally = { userId, displayName: team.playerNames[idx], roundsPlayed: 0, wins: 0, totalStrokes: 0, perRound: [] };
            byUser.set(userId, tally);
          }
          tally.roundsPlayed += 1;
          tally.totalStrokes += standing.total;
          if (won) tally.wins += 1;
          tally.perRound.push({
            roundId: sc.round_id,
            roundName: sc.round_name,
            teamName: team.name,
            teammateNames: team.playerNames.filter((_, i) => i !== idx),
            total: standing.total,
            rank: standing.rank,
            won,
          });
        });
      }
    }
  }

  return [...byUser.values()].sort(
    (a, b) => b.wins - a.wins || a.totalStrokes - b.totalStrokes || a.displayName.localeCompare(b.displayName),
  );
}
