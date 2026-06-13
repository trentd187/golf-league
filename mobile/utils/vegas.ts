// utils/vegas.ts
// Pure calculation helpers for the Las Vegas 2v2 team game. Kept free of React so
// they can be unit-tested in isolation and reused by both the editable Basic Vegas
// scorecard (live, from local score state) and the read-only Matches tabs (from the
// server scorecard). Nothing here persists — Vegas points are always derived.
//
// Rules implemented:
//   - Each twosome combines its two players' scores into a two-digit number, LOW
//     digit first (4 & 5 → 45; two 4s → 44). A single score of 10+ is capped at 9
//     when forming the number (house rule; the stored gross score is unchanged).
//   - The hole's differential is the gap between the two teams' numbers; the LOWER
//     number wins that many points.
//   - Flip rule (optional): when a team makes a birdie-or-better, the OPPONENTS'
//     number is flipped HIGH-digit-first (56 → 65), increasing the swing.
//   - "Birdie" is value < par, where value is gross or net per the round's basis.

import type { Scorecard, ScorecardGroup, ScorecardHole } from "@/types/scorecard";

export type VegasBasis = "gross" | "net";

// VegasHoleEntry is one player's contribution to a team on one hole.
export interface VegasHoleEntry {
  value: number | null; // gross or net score per basis; null = not entered
  par: number | null; // hole par; null when the course has no par data
}

// VegasTeamInfo describes one of the two teams in a group match.
export interface VegasTeamInfo {
  teamId: string;
  name: string;
  roundPlayerIds: string[];
  userIds: string[];
  playerNames: string[];
}

// VegasHoleResult is the computed outcome of one hole for a Team A vs Team B match.
export interface VegasHoleResult {
  holeNumber: number;
  teamANatural: number | null; // pre-flip combined number
  teamBNatural: number | null;
  teamANumber: number | null; // post-flip final number used for scoring
  teamBNumber: number | null;
  pointsA: number; // signed: positive = Team A won points this hole
  winner: "A" | "B" | "tie" | null; // null when the hole is incomplete
  flipAppliedToA: boolean;
  flipAppliedToB: boolean;
  complete: boolean; // both team numbers present
}

// VegasMatchHole extends a hole result with the running total after that hole.
export interface VegasMatchHole extends VegasHoleResult {
  runningTotalA: number;
}

// VegasRoundMatch is a full Team A vs Team B match for one group in one round.
export interface VegasRoundMatch {
  groupId: string;
  groupNumber: number;
  teamA: VegasTeamInfo;
  teamB: VegasTeamInfo;
  holes: VegasMatchHole[];
  finalTotalA: number;
  winner: "A" | "B" | "tie";
  complete: boolean; // every hole has both team numbers
}

// VegasEventRoundDetail is one player's result in one Vegas round (event tally).
export interface VegasEventRoundDetail {
  roundId: string;
  roundName: string;
  partnerName: string | null;
  opponentNames: string[];
  netPoints: number;
}

// VegasEventPlayerTally is a player's cumulative Vegas standing across an event.
export interface VegasEventPlayerTally {
  userId: string;
  displayName: string;
  roundsPlayed: number;
  netPoints: number;
  perRound: VegasEventRoundDetail[];
}

// clampForCombine caps a single hole score at 9 so two scores always form a clean
// two-digit number (the "cap the hole at 9" house rule for blow-up holes).
export function clampForCombine(score: number): number {
  return Math.min(score, 9);
}

// combineTeamNumber forms a team's two-digit number from its two players' scores,
// LOW digit first (each capped at 9). Returns null when either score is missing.
export function combineTeamNumber(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  const lo = Math.min(clampForCombine(a), clampForCombine(b));
  const hi = Math.max(clampForCombine(a), clampForCombine(b));
  return lo * 10 + hi;
}

// teamHasBirdie reports whether any of a team's players scored under par on the hole.
// Undeterminable entries (missing value or par) never count as a birdie.
export function teamHasBirdie(entries: VegasHoleEntry[]): boolean {
  return entries.some((e) => e.value !== null && e.par !== null && e.value < e.par);
}

// flipTeamNumber swaps a combined number to HIGH digit first (56 → 65). A
// palindrome like 44 is unchanged. Expects a low-first two-digit number.
export function flipTeamNumber(n: number): number {
  return (n % 10) * 10 + Math.floor(n / 10);
}

// holeDifferential computes one hole's Team A vs Team B outcome. When flipEnabled,
// a birdie by one team flips the OPPONENTS' number high-first before comparison.
export function holeDifferential(
  holeNumber: number,
  teamA: VegasHoleEntry[],
  teamB: VegasHoleEntry[],
  flipEnabled: boolean,
): VegasHoleResult {
  const aNatural = combineTeamNumber(teamA[0]?.value ?? null, teamA[1]?.value ?? null);
  const bNatural = combineTeamNumber(teamB[0]?.value ?? null, teamB[1]?.value ?? null);

  // Incomplete hole — at least one team can't form a number yet.
  if (aNatural === null || bNatural === null) {
    return {
      holeNumber,
      teamANatural: aNatural,
      teamBNatural: bNatural,
      teamANumber: null,
      teamBNumber: null,
      pointsA: 0,
      winner: null,
      flipAppliedToA: false,
      flipAppliedToB: false,
      complete: false,
    };
  }

  // Opponents' number flips when YOU birdie.
  const flipAppliedToB = flipEnabled && teamHasBirdie(teamA);
  const flipAppliedToA = flipEnabled && teamHasBirdie(teamB);
  const aNum = flipAppliedToA ? flipTeamNumber(aNatural) : aNatural;
  const bNum = flipAppliedToB ? flipTeamNumber(bNatural) : bNatural;

  // Lower number wins; pointsA is positive when Team A has the lower number.
  const pointsA = bNum - aNum;
  const winner = pointsA > 0 ? "A" : pointsA < 0 ? "B" : "tie";

  return {
    holeNumber,
    teamANatural: aNatural,
    teamBNatural: bNatural,
    teamANumber: aNum,
    teamBNumber: bNum,
    pointsA,
    winner,
    flipAppliedToA,
    flipAppliedToB,
    complete: true,
  };
}

// scoreValue reads a player's score for a hole by basis, or null if not entered.
function scoreValue(
  player: ScorecardGroup["players"][number],
  holeNumber: number,
  basis: VegasBasis,
): number | null {
  const s = player.scores.find((sc) => sc.hole_number === holeNumber);
  if (!s) return null;
  return basis === "net" ? s.net_score : s.gross_score;
}

// groupTeams collects the distinct teams in a group (players carry team_id/team_name).
// Returns them in a stable order (by name, then id) so Team A/B are deterministic.
function groupTeams(group: ScorecardGroup): VegasTeamInfo[] {
  const byId = new Map<string, VegasTeamInfo>();
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

// buildRoundMatch builds the Team A vs Team B match for one group, or null when the
// group does not yet have two teams ("waiting for opponents"). When perspectiveTeamId
// is given and matches the second team, the two teams are swapped so the viewing
// player's team is always Team A.
export function buildRoundMatch(
  group: ScorecardGroup,
  holes: ScorecardHole[],
  basis: VegasBasis,
  flipEnabled: boolean,
  perspectiveTeamId?: string,
): VegasRoundMatch | null {
  const teams = groupTeams(group);
  if (teams.length < 2) return null;

  let teamA = teams[0];
  let teamB = teams[1];
  if (perspectiveTeamId && teamB.teamId === perspectiveTeamId) {
    [teamA, teamB] = [teamB, teamA];
  }

  const playersFor = (team: VegasTeamInfo) =>
    group.players.filter((p) => p.team_id === team.teamId);
  const teamAPlayers = playersFor(teamA);
  const teamBPlayers = playersFor(teamB);

  let running = 0;
  let allComplete = true;
  const matchHoles: VegasMatchHole[] = holes.map((h) => {
    const aEntries: VegasHoleEntry[] = teamAPlayers.map((p) => ({
      value: scoreValue(p, h.hole_number, basis),
      par: h.par || null,
    }));
    const bEntries: VegasHoleEntry[] = teamBPlayers.map((p) => ({
      value: scoreValue(p, h.hole_number, basis),
      par: h.par || null,
    }));
    const result = holeDifferential(h.hole_number, aEntries, bEntries, flipEnabled);
    running += result.pointsA;
    if (!result.complete) allComplete = false;
    return { ...result, runningTotalA: running };
  });

  const finalTotalA = running;
  const winner = finalTotalA > 0 ? "A" : finalTotalA < 0 ? "B" : "tie";

  return {
    groupId: group.group_id,
    groupNumber: group.group_number,
    teamA,
    teamB,
    holes: matchHoles,
    finalTotalA,
    winner,
    complete: allComplete,
  };
}

// normalizeStrokeIndexes ranks holes by ascending stroke_index (1 = hardest) so
// handicap strokes allocate correctly even when playing a 9-hole subset. Mirrors
// the backend NormalizeStrokeIndexes so client-computed net matches the server.
export function normalizeStrokeIndexes(holes: ScorecardHole[]): Record<number, number> {
  const sorted = [...holes].sort((a, b) => a.stroke_index - b.stroke_index);
  const map: Record<number, number> = {};
  sorted.forEach((h, i) => {
    map[h.hole_number] = i + 1;
  });
  return map;
}

// holeHandicapStrokes returns the strokes a player receives on a hole given their
// effective handicap, the hole's normalized stroke-index rank, and the hole count.
// Mirrors the backend HandicapStrokes allocation rule.
export function holeHandicapStrokes(effHandicap: number, normalizedSI: number, holeCount: number): number {
  if (effHandicap <= 0 || normalizedSI <= 0 || holeCount <= 0) return 0;
  const full = Math.floor(effHandicap / holeCount);
  const remainder = effHandicap % holeCount;
  return full + (normalizedSI <= remainder ? 1 : 0);
}

// buildLiveVegasMatch builds a match from live local gross-score input (rpId → hole →
// gross string) rather than the server scorecard, so the editable Basic Vegas view
// updates as the user types. Net values are computed client-side from each player's
// effective handicap when the basis is net. Returns null when the group lacks two teams.
export function buildLiveVegasMatch(
  group: ScorecardGroup,
  holes: ScorecardHole[],
  localGross: Record<string, Record<number, string>>,
  basis: VegasBasis,
  flipEnabled: boolean,
  effHandicaps: Record<string, number | null>,
  perspectiveTeamId?: string,
): VegasRoundMatch | null {
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

  return buildRoundMatch({ ...group, players }, holes, basis, flipEnabled, perspectiveTeamId);
}

// buildRoundMatches builds a match for every group in the scorecard that has two
// teams. Groups without two teams are omitted (they show a waiting state upstream).
export function buildRoundMatches(sc: Scorecard): VegasRoundMatch[] {
  const basis: VegasBasis = sc.vegas_scoring_basis === "net" ? "net" : "gross";
  const out: VegasRoundMatch[] = [];
  for (const group of sc.groups) {
    const match = buildRoundMatch(group, sc.holes, basis, sc.vegas_birdie_flip);
    if (match) out.push(match);
  }
  return out;
}

// buildEventTally aggregates net Vegas points per player across multiple completed
// Vegas round scorecards. Non-Vegas scorecards and groups without two teams are
// skipped. Result is sorted by net points (most won first).
export function buildEventTally(scorecards: Scorecard[]): VegasEventPlayerTally[] {
  const byUser = new Map<string, VegasEventPlayerTally>();

  const credit = (
    team: VegasTeamInfo,
    opponents: VegasTeamInfo,
    points: number,
    sc: Scorecard,
  ) => {
    team.userIds.forEach((userId, idx) => {
      let tally = byUser.get(userId);
      if (!tally) {
        tally = { userId, displayName: team.playerNames[idx], roundsPlayed: 0, netPoints: 0, perRound: [] };
        byUser.set(userId, tally);
      }
      const partnerName = team.playerNames.find((_, i) => i !== idx) ?? null;
      tally.netPoints += points;
      tally.roundsPlayed += 1;
      tally.perRound.push({
        roundId: sc.round_id,
        roundName: sc.round_name,
        partnerName,
        opponentNames: opponents.playerNames,
        netPoints: points,
      });
    });
  };

  for (const sc of scorecards) {
    if (sc.scoring_format !== "las_vegas") continue;
    for (const match of buildRoundMatches(sc)) {
      credit(match.teamA, match.teamB, match.finalTotalA, sc);
      credit(match.teamB, match.teamA, -match.finalTotalA, sc);
    }
  }

  return [...byUser.values()].sort((a, b) => b.netPoints - a.netPoints || a.displayName.localeCompare(b.displayName));
}
