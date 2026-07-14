// utils/leaderboard.ts
// Who is winning. Round standings and event standings, derived from scorecards.
//
// Why this file exists. buildLeaderboard and buildEventLeaderboard used to be declared INSIDE
// the component bodies of app/rounds/[id].tsx and app/events/[id].tsx — both of which are
// excluded from the Jest coverage set (they're large screens, slated for E2E). So the code
// that decides WHO WINS had zero tests and was invisible to the coverage ratchet: it could be
// changed freely and nothing would notice. That is precisely the failure the extract-first rule
// in CLAUDE.md exists to prevent, and it had happened to the most consequential math in the app.
//
// They also duplicated each other's par accumulation and tie-rank loops, with a subtle
// divergence: the round board sinks 0-hole players to the bottom (a live round has players who
// haven't teed off), while the event board simply skips them (a player with no scores isn't in
// the standings at all). Both behaviours are preserved and now pinned by tests.
//
// Ranking rule, shared by both: sort ascending by NET-to-par (falling back to raw net total
// when a round has no hole/par data); ties share a "T"-prefixed rank ("T1", "T1", "T3").

import type { Scorecard } from "@/types/scorecard";

// LeaderboardEntry is one player's standing within a single round.
export interface LeaderboardEntry {
  round_player_id: string;
  display_name: string;
  rank: string; // "1", "T2", or "—" for a player who hasn't started
  holesPlayed: number;
  grossTotal: number;
  netTotal: number;
  grossToPar: number | null; // null when the round has no hole/par data
  netToPar: number | null;
}

// EventLeaderboardEntry is one player's standing across every completed round in an event.
export interface EventLeaderboardEntry {
  user_id: string;
  display_name: string;
  roundsPlayed: number;
  grossTotal: number;
  netTotal: number;
  grossToPar: number | null; // null when ANY counted round lacks hole/par data
  netToPar: number | null;
  rank: string;
}

// Rankable is the minimum a row needs to be ranked: a net-to-par (preferred) and a raw net.
interface Rankable {
  netToPar: number | null;
  netTotal: number;
}

// rankScore is the single sort key. netToPar is preferred; netTotal is the fallback for a
// round with no hole data (a course imported without pars). Both boards must agree on this or
// their standings would silently disagree with each other.
function rankScore(e: Rankable): number {
  return e.netToPar ?? e.netTotal;
}

// assignRanks converts a SORTED list into rank strings. A player tied with anyone else gets a
// "T" prefix, and tied players share the rank of the first of them: 1, T2, T2, 4.
//
// `isRanked` lets the round board exclude not-yet-started players from ranking (they render
// "—") while still keeping them in the list, which the event board has no need for.
function assignRanks<T extends Rankable>(
  sorted: T[],
  isRanked: (e: T) => boolean = () => true,
): (T & { rank: string })[] {
  const ranked = sorted.filter(isRanked);
  // How many players share each score — a score seen more than once is a tie.
  const countByScore = new Map<number, number>();
  for (const e of ranked) {
    const s = rankScore(e);
    countByScore.set(s, (countByScore.get(s) ?? 0) + 1);
  }

  let rank = 1;
  let prevScore: number | null = null;
  let position = 0;

  return sorted.map((e) => {
    if (!isRanked(e)) return { ...e, rank: "—" };

    position += 1;
    const score = rankScore(e);
    // A new score claims the current position; an equal score keeps the previous rank.
    if (prevScore !== null && score !== prevScore) rank = position;
    prevScore = score;

    const tied = (countByScore.get(score) ?? 0) > 1;
    return { ...e, rank: tied ? `T${rank}` : `${rank}` };
  });
}

// parPlayedFor sums the par of only the holes a player has actually scored, so a partially
// played round compares like-for-like against par rather than against the full 18.
function parPlayedFor(
  scores: { hole_number: number }[],
  holePar: Map<number, number>,
): number {
  return scores.reduce((sum, s) => sum + (holePar.get(s.hole_number) ?? 0), 0);
}

// buildRoundLeaderboard ranks the players of one round.
//
// Players who have not scored a hole sink to the BOTTOM and rank "—": in a live round they
// simply haven't teed off, and leaving them at 0-under would put them top of the board.
export function buildRoundLeaderboard(sc: Scorecard): LeaderboardEntry[] {
  const holePar = new Map(sc.holes.map((h) => [h.hole_number, h.par]));
  const hasHoles = sc.holes.length > 0;

  const entries = sc.groups
    .flatMap((g) =>
      g.players.map((p) => {
        const grossTotal = p.scores.reduce((s, x) => s + x.gross_score, 0);
        const netTotal = p.scores.reduce((s, x) => s + x.net_score, 0);
        const parPlayed = hasHoles ? parPlayedFor(p.scores, holePar) : 0;
        return {
          round_player_id: p.round_player_id,
          display_name: p.display_name,
          holesPlayed: p.scores.length,
          grossTotal,
          netTotal,
          grossToPar: hasHoles ? grossTotal - parPlayed : null,
          netToPar: hasHoles ? netTotal - parPlayed : null,
        };
      }),
    )
    .sort((a, b) => {
      // Not-yet-started players sink, regardless of score.
      if (a.holesPlayed === 0 && b.holesPlayed !== 0) return 1;
      if (b.holesPlayed === 0 && a.holesPlayed !== 0) return -1;
      const diff = rankScore(a) - rankScore(b);
      if (diff !== 0) return diff;
      // Tiebreak: further through the round ranks higher (more of the score is known).
      return b.holesPlayed - a.holesPlayed;
    });

  return assignRanks(entries, (e) => e.holesPlayed > 0);
}

// buildEventLeaderboard aggregates every completed scorecard by user and ranks the totals.
//
// Unlike the round board, a player with no scores is simply ABSENT — they are not in the
// standings at all, rather than sitting at the bottom.
export function buildEventLeaderboard(scorecards: Scorecard[]): EventLeaderboardEntry[] {
  const byUser = new Map<string, Omit<EventLeaderboardEntry, "rank">>();

  for (const sc of scorecards) {
    const holePar = new Map(sc.holes.map((h) => [h.hole_number, h.par]));
    const hasHoles = sc.holes.length > 0;

    for (const group of sc.groups) {
      for (const p of group.players) {
        if (p.scores.length === 0) continue;

        const gross = p.scores.reduce((s, x) => s + x.gross_score, 0);
        const net = p.scores.reduce((s, x) => s + x.net_score, 0);
        const parPlayed = hasHoles ? parPlayedFor(p.scores, holePar) : 0;
        const roundGrossToPar = hasHoles ? gross - parPlayed : null;
        const roundNetToPar = hasHoles ? net - parPlayed : null;

        const existing = byUser.get(p.user_id);
        if (!existing) {
          byUser.set(p.user_id, {
            user_id: p.user_id,
            display_name: p.display_name,
            roundsPlayed: 1,
            grossTotal: gross,
            netTotal: net,
            grossToPar: roundGrossToPar,
            netToPar: roundNetToPar,
          });
          continue;
        }

        existing.roundsPlayed += 1;
        existing.grossTotal += gross;
        existing.netTotal += net;

        // To-par POISONS: if ANY counted round lacks hole/par data, the aggregate to-par is
        // meaningless and becomes null for the whole player. Summing a subset would quietly
        // flatter whoever happened to play the round with missing pars.
        if (existing.grossToPar !== null && roundGrossToPar !== null && roundNetToPar !== null) {
          existing.grossToPar += roundGrossToPar;
          existing.netToPar = (existing.netToPar ?? 0) + roundNetToPar;
        } else {
          existing.grossToPar = null;
          existing.netToPar = null;
        }
      }
    }
  }

  const entries = [...byUser.values()].sort((a, b) => rankScore(a) - rankScore(b));
  return assignRanks(entries);
}

// formatThru renders a player's progress: "F" once the round is complete, the hole count while
// they're out on the course, and "—" before they've started.
export function formatThru(holesPlayed: number, holeCount: number): string {
  if (holesPlayed === 0) return "—";
  return holesPlayed >= holeCount ? "F" : `${holesPlayed}`;
}
