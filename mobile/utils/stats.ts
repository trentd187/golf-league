// utils/stats.ts
// Shared stat computation utilities used by the round detail, event detail, and
// future stats screens.
//
// buildStats accepts an array of Scorecard objects so the same function works for:
//   - A single round  → pass [scorecard]
//   - An event        → pass all completed round scorecards
// Players are deduplicated by user_id when aggregating across multiple scorecards.

import type { Scorecard } from "@/types/scorecard";
import type { StatRow, StatSummary } from "@/types/scorecard";

// buildStats: aggregates birdies, putts, GIR, and FIR per player across all provided
// scorecards and returns top-3 ranked entries for each category.
export function buildStats(scorecards: Scorecard[]): StatSummary[] {
  // Aggregate per-player across all scorecards; user_id is the stable cross-round key.
  const playerMap = new Map<string, {
    display_name: string;
    birdies:  number;
    putts:    number | null;
    greens:   number;
    fairways: number;
  }>();

  for (const sc of scorecards) {
    const holeMap = new Map(sc.holes.map((h) => [h.hole_number, h.par]));
    for (const group of sc.groups) {
      for (const p of group.players) {
        const birdies  = p.scores.filter(
          (s) => (holeMap.get(s.hole_number) ?? -99) === s.gross_score + 1
        ).length;
        const validPutts = p.hole_stats.filter((hs) => hs.putts !== null);
        // null means the player entered no putt data this round — kept distinct from 0 putts.
        const roundPutts = validPutts.length > 0
          ? validPutts.reduce((s, hs) => s + (hs.putts ?? 0), 0)
          : null;
        const greens   = p.hole_stats.filter((hs) => hs.gir === "hit").length;
        const fairways = p.hole_stats.filter((hs) => hs.fir === true).length;

        const existing = playerMap.get(p.user_id);
        if (existing) {
          existing.birdies  += birdies;
          // Merge putt counts: treat null as 0 once any round has real data.
          existing.putts = existing.putts !== null || roundPutts !== null
            ? (existing.putts ?? 0) + (roundPutts ?? 0)
            : null;
          existing.greens   += greens;
          existing.fairways += fairways;
        } else {
          playerMap.set(p.user_id, {
            display_name: p.display_name,
            birdies,
            putts: roundPutts,
            greens,
            fairways,
          });
        }
      }
    }
  }

  // findTop3: sorts by stat value, groups ties into shared rank rows, returns up to 3.
  // higherIsBetter=true: most birdies/greens/fairways wins.
  // higherIsBetter=false: fewest putts wins.
  // A best value of 0 on a higher-is-better stat is treated as "no meaningful data".
  function findTop3(nameValMap: Map<string, number | null>, higherIsBetter: boolean): StatRow[] {
    const valid = [...nameValMap.entries()]
      .filter((e): e is [string, number] => e[1] !== null)
      .sort(([, a], [, b]) => higherIsBetter ? b - a : a - b);
    const rows: StatRow[] = [];
    let playerRank = 1;
    let i = 0;
    while (i < valid.length && rows.length < 3) {
      const value = valid[i][1];
      if (higherIsBetter && value === 0) break;
      const names: string[] = [];
      while (i < valid.length && valid[i][1] === value) { names.push(valid[i][0]); i++; }
      rows.push({ rank: names.length > 1 ? `T${playerRank}` : `${playerRank}`, names, value });
      playerRank += names.length;
    }
    return rows;
  }

  // Build display_name-keyed maps for findTop3 output.
  const birdies  = new Map([...playerMap.values()].map((d) => [d.display_name, d.birdies]));
  const putts    = new Map([...playerMap.values()].map((d) => [d.display_name, d.putts]));
  const greens   = new Map([...playerMap.values()].map((d) => [d.display_name, d.greens]));
  const fairways = new Map([...playerMap.values()].map((d) => [d.display_name, d.fairways]));

  return [
    { category: "Birdies",  unit: "birdies", top3: findTop3(birdies,  true)  },
    { category: "Putts",    unit: "putts",   top3: findTop3(putts,    false) },
    { category: "Greens",   unit: "GIR",     top3: findTop3(greens,   true)  },
    { category: "Fairways", unit: "FIR",     top3: findTop3(fairways, true)  },
  ];
}
