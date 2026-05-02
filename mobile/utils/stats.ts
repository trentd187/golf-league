// utils/stats.ts
// Shared stat computation utilities used by the stats screen, round detail, and
// event detail screens.
//
// buildStats accepts an array of Scorecard objects so the same function works for:
//   - A single round  → pass [scorecard]
//   - An event        → pass all completed round scorecards
// Players are deduplicated by user_id when aggregating across multiple scorecards.
//
// buildRoundStats and buildMyStats are the personal stats builders extracted from
// app/(tabs)/stats.tsx so they can be unit tested independently of React.

import type { Scorecard, ScorecardPlayer, ScorecardHole } from "@/types/scorecard";
import type { StatRow, StatSummary } from "@/types/scorecard";

// RoundRef is the minimal shape buildMyStats needs from the rounds list.
// The full RoundSummary from the stats screen satisfies this structurally.
export type RoundRef = { id: string; scheduled_date: string };

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

// toPar formats a gross-to-par difference as "+N", "-N", or "E".
export function toPar(gross: number, par: number): string {
  const diff = gross - par;
  if (diff === 0) return "E";
  return diff > 0 ? `+${diff}` : `${diff}`;
}

// scoreTextColor returns a hardcoded categorical color class based on result vs par.
// Score colors encode meaning (eagle/birdie/par/bogey/double+), so they must NOT use
// theme tokens — the color IS the signal. See CLAUDE.md categorical color rule.
export function scoreTextColor(gross: number, par: number): string {
  const diff = gross - par;
  if (diff <= -2) return "text-yellow-500"; // eagle or better
  if (diff === -1) return "text-green-600"; // birdie
  if (diff === 1)  return "text-amber-500"; // bogey
  if (diff >= 2)   return "text-red-500";   // double bogey or worse
  return ""; // par — inherit theme color
}

// findMyPlayer locates the caller's ScorecardPlayer entry using the DB UUID the
// server returns in caller_user_id — the Supabase auth UUID differs from the DB UUID.
export function findMyPlayer(sc: Scorecard): ScorecardPlayer | undefined {
  for (const group of sc.groups) {
    const p = group.players.find((pl) => pl.user_id === sc.caller_user_id);
    if (p) return p;
  }
  return undefined;
}

// findPlayerById finds any player in a scorecard by their DB user UUID.
// Used when viewing another user's stats (where caller_user_id is not the target).
export function findPlayerById(sc: Scorecard, userId: string): ScorecardPlayer | undefined {
  for (const group of sc.groups) {
    const p = group.players.find((pl) => pl.user_id === userId);
    if (p) return p;
  }
  return undefined;
}

// buildRoundStats computes all per-hole stats for one player in a single round.
// Returns the same shape used by the shared display components (ScoringCard,
// DirectionalMissCard, PuttingCard) so the round modal reuses them unchanged.
export function buildRoundStats(player: ScorecardPlayer, holes: ScorecardHole[]) {
  const holeMap = new Map(holes.map((h) => [h.hole_number, h.par]));

  let birdies = 0, pars = 0, bogeys = 0, doubles = 0;
  let par3Total = 0, par3Count = 0;
  let par4Total = 0, par4Count = 0;
  let par5Total = 0, par5Count = 0;

  for (const s of player.scores) {
    const par = holeMap.get(s.hole_number);
    if (par == null) continue;
    const diff = s.gross_score - par;
    if (diff <= -1)      birdies++;
    else if (diff === 0) pars++;
    else if (diff === 1) bogeys++;
    else                 doubles++;

    if (par === 3)      { par3Total += s.gross_score; par3Count++; }
    else if (par === 4) { par4Total += s.gross_score; par4Count++; }
    else if (par === 5) { par5Total += s.gross_score; par5Count++; }
  }

  const greensHit       = player.hole_stats.filter((hs) => hs.gir === "hit").length;
  const greensTotal     = player.hole_stats.filter((hs) => hs.gir !== null && hs.gir !== "na").length;
  const girNaCount      = player.hole_stats.filter((hs) => hs.gir === "na").length;
  const girTrackedTotal = player.hole_stats.filter((hs) => hs.gir !== null).length;
  const fairwaysHit     = player.hole_stats.filter((hs) => hs.fir === true).length;
  const fairwaysTotal   = player.hole_stats.filter((hs) => hs.fir !== null).length;

  let firMissLeft = 0, firMissRight = 0, firMissShort = 0, firMissLong = 0;
  let girMissLeft = 0, girMissRight = 0, girMissShort = 0, girMissLong = 0;
  let putts1 = 0, putts2 = 0, putts3 = 0, putts4Plus = 0;
  let totalPutts = 0, totalPuttHoles = 0;
  let puttMadeTotal = 0, puttMadeCount = 0, puttMadeLongest = 0;
  const proximityBuckets = new Map<number, { total: number; count: number }>();

  for (const hs of player.hole_stats) {
    if (hs.fir === false) {
      if (hs.fir_miss_direction === "left")       firMissLeft++;
      else if (hs.fir_miss_direction === "right") firMissRight++;
      else if (hs.fir_miss_direction === "short") firMissShort++;
      else if (hs.fir_miss_direction === "long")  firMissLong++;
    }
    if (hs.gir === "miss") {
      if (hs.gir_miss_direction === "left")       girMissLeft++;
      else if (hs.gir_miss_direction === "right") girMissRight++;
      else if (hs.gir_miss_direction === "short") girMissShort++;
      else if (hs.gir_miss_direction === "long")  girMissLong++;
    }
    if (hs.gir === "hit" && hs.approach_yds !== null && hs.first_putt_distance !== null) {
      const band = Math.floor(hs.approach_yds / 20) * 20;
      const bucket = proximityBuckets.get(band) ?? { total: 0, count: 0 };
      bucket.total += hs.first_putt_distance;
      bucket.count++;
      proximityBuckets.set(band, bucket);
    }
    if (hs.putts !== null) {
      if (hs.putts === 1)      putts1++;
      else if (hs.putts === 2) putts2++;
      else if (hs.putts === 3) putts3++;
      else if (hs.putts >= 4)  putts4Plus++;
      totalPutts += hs.putts;
      totalPuttHoles++;
    }
    if (hs.putt_distance_made !== null && hs.putt_distance_made > 0) {
      puttMadeTotal += hs.putt_distance_made;
      puttMadeCount++;
      if (hs.putt_distance_made > puttMadeLongest) puttMadeLongest = hs.putt_distance_made;
    }
  }

  return {
    birdies, pars, bogeys, doubles,
    avgPar3: par3Count > 0 ? par3Total / par3Count : null,
    avgPar4: par4Count > 0 ? par4Total / par4Count : null,
    avgPar5: par5Count > 0 ? par5Total / par5Count : null,
    firPercent:    fairwaysTotal > 0 ? (fairwaysHit / fairwaysTotal) * 100 : null,
    firMiss: { left: firMissLeft, right: firMissRight, short: firMissShort, long: firMissLong },
    firTotal: fairwaysTotal,
    girPercent:    greensTotal > 0   ? (greensHit / greensTotal) * 100     : null,
    girMiss: { left: girMissLeft, right: girMissRight, short: girMissShort, long: girMissLong },
    girTotal: greensTotal,
    girNaPercent:  girTrackedTotal > 0 ? (girNaCount / girTrackedTotal) * 100 : null,
    proximityRows: Array.from(proximityBuckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([band, { total, count }]) => ({
        label: `${band}–${band + 19} yds`,
        value: `${(total / count).toFixed(1)} ft`,
      })),
    avgPuttsPerRound: totalPuttHoles > 0 ? (totalPutts / totalPuttHoles) * 18 : null,
    puttDist: { one: putts1, two: putts2, three: putts3, fourPlus: putts4Plus },
    avgPuttMadeDistance: puttMadeCount > 0 ? puttMadeTotal / puttMadeCount : null,
    longestPuttMade:     puttMadeCount > 0 ? puttMadeLongest                : null,
  };
}

// buildMyStats aggregates a player's stats across a set of scorecards.
// When userId is provided, stats are computed for that player; otherwise defaults
// to the caller (via caller_user_id) for the personal stats screen.
// roundsList is used to pair 9-hole rounds by event + date so front and back halves
// form one 18-hole equivalent score. Only id and scheduled_date are needed.
export function buildMyStats(scorecards: Scorecard[], roundsList: RoundRef[], userId?: string) {
  // Pick the finder based on whether we're computing for a specific user or the caller.
  const findPlayer = userId
    ? (sc: Scorecard) => findPlayerById(sc, userId)
    : findMyPlayer;
  // ── Gross score collection ──────────────────────────────────────────────────
  // Only 18-hole-equivalent totals go into avg/low/high.
  //   • Full 18-hole rounds: use total_gross directly.
  //   • 9-hole rounds: pair a "front" and "back" from the same event on the same
  //     date; sum the two halves. Unpaired halves are excluded.
  // Per-hole stats (distribution, par averages, GIR, FIR, putts) accumulate from
  // every scorecard regardless of round length.

  const roundMap = new Map(roundsList.map((r) => [r.id, r]));

  // Collect all 18-hole-equivalent gross scores into one array so the Scores tab
  // can derive its own avg/low/high from the same source (returned as grossScores).
  const grossScores: number[] = [];

  // Full 18-hole rounds count directly.
  for (const sc of scorecards) {
    if (sc.nine_hole_selection !== null) continue;
    const player = findPlayer(sc);
    if (player?.total_gross != null) grossScores.push(player.total_gross);
  }

  // 9-hole rounds are paired chronologically — any two combine into one 18-hole
  // equivalent regardless of which nine, course, or event. Oldest pair first so
  // only the most recent round can be left unpaired when the count is odd.
  const nineHoleEntries: { gross: number; date: string }[] = [];
  for (const sc of scorecards) {
    if (sc.nine_hole_selection === null) continue;
    const r = roundMap.get(sc.round_id);
    if (!r) continue;
    const player = findPlayer(sc);
    if (player?.total_gross != null) {
      nineHoleEntries.push({ gross: player.total_gross, date: r.scheduled_date });
    }
  }
  nineHoleEntries.sort((a, b) => a.date.localeCompare(b.date));
  // Pair [0+1], [2+3], … — an odd last entry is left unpaired.
  for (let i = 0; i + 1 < nineHoleEntries.length; i += 2) {
    grossScores.push(nineHoleEntries[i].gross + nineHoleEntries[i + 1].gross);
  }

  // ── Per-hole accumulators (all rounds, any length) ──────────────────────────
  let rounds = 0;
  let totalPutts = 0;
  let totalPuttHoles = 0; // sum of holes with putt data — used to normalise to per-18 average
  let greensHit = 0;
  let greensTotal = 0;
  let girNaCount = 0;
  let girTrackedTotal = 0; // hit + miss + na
  let fairwaysHit = 0;
  let fairwaysTotal = 0;
  let firMissLeft = 0, firMissRight = 0, firMissShort = 0, firMissLong = 0;
  let girMissLeft = 0, girMissRight = 0, girMissShort = 0, girMissLong = 0;

  // Approach proximity: for GIR holes, bucket approach_yds into 20-yd bands and
  // average first_putt_distance (feet). Key = band start (0, 20, 40, …).
  const proximityBuckets = new Map<number, { total: number; count: number }>();

  let birdiesOrBetter = 0;
  let parsCount = 0;
  let bogeysCount = 0;
  let doublesPlus = 0;

  let putts1 = 0, putts2 = 0, putts3 = 0, putts4Plus = 0;
  let puttMadeTotal = 0, puttMadeCount = 0, puttMadeLongest = 0;

  let par3Total = 0, par3Count = 0;
  let par4Total = 0, par4Count = 0;
  let par5Total = 0, par5Count = 0;

  for (const sc of scorecards) {
    const holeMap = new Map(sc.holes.map((h) => [h.hole_number, h.par]));
    const player = findPlayer(sc);
    if (!player) continue;

    rounds++;

    const validPutts = player.hole_stats.filter((hs) => hs.putts !== null);
    if (validPutts.length > 0) {
      totalPutts    += validPutts.reduce((sum, hs) => sum + (hs.putts ?? 0), 0);
      totalPuttHoles += validPutts.length;
    }

    // GIR: exclude "na" holes from the hit% denominator; track them separately for the N/A stat.
    greensHit      += player.hole_stats.filter((hs) => hs.gir === "hit").length;
    greensTotal    += player.hole_stats.filter((hs) => hs.gir !== null && hs.gir !== "na").length;
    girNaCount     += player.hole_stats.filter((hs) => hs.gir === "na").length;
    girTrackedTotal += player.hole_stats.filter((hs) => hs.gir !== null).length;

    fairwaysHit   += player.hole_stats.filter((hs) => hs.fir === true).length;
    fairwaysTotal += player.hole_stats.filter((hs) => hs.fir !== null).length;
    for (const hs of player.hole_stats) {
      if (hs.fir === false) {
        if (hs.fir_miss_direction === "left")  firMissLeft++;
        else if (hs.fir_miss_direction === "right") firMissRight++;
        else if (hs.fir_miss_direction === "short") firMissShort++;
        else if (hs.fir_miss_direction === "long")  firMissLong++;
      }
      if (hs.gir === "miss") {
        if (hs.gir_miss_direction === "left")  girMissLeft++;
        else if (hs.gir_miss_direction === "right") girMissRight++;
        else if (hs.gir_miss_direction === "short") girMissShort++;
        else if (hs.gir_miss_direction === "long")  girMissLong++;
      }
      // Proximity: only GIR holes with both approach distance and first putt distance recorded.
      if (hs.gir === "hit" && hs.approach_yds !== null && hs.first_putt_distance !== null) {
        const band = Math.floor(hs.approach_yds / 20) * 20;
        const bucket = proximityBuckets.get(band) ?? { total: 0, count: 0 };
        bucket.total += hs.first_putt_distance;
        bucket.count++;
        proximityBuckets.set(band, bucket);
      }
      if (hs.putts !== null) {
        if (hs.putts === 1)      putts1++;
        else if (hs.putts === 2) putts2++;
        else if (hs.putts === 3) putts3++;
        else if (hs.putts >= 4)  putts4Plus++;
      }
      if (hs.putt_distance_made !== null && hs.putt_distance_made > 0) {
        puttMadeTotal += hs.putt_distance_made;
        puttMadeCount++;
        if (hs.putt_distance_made > puttMadeLongest) puttMadeLongest = hs.putt_distance_made;
      }
    }

    for (const s of player.scores) {
      const par = holeMap.get(s.hole_number);
      if (par == null) continue;
      const diff = s.gross_score - par;

      if (diff <= -1)      birdiesOrBetter++;
      else if (diff === 0) parsCount++;
      else if (diff === 1) bogeysCount++;
      else                 doublesPlus++;

      if (par === 3)      { par3Total += s.gross_score; par3Count++; }
      else if (par === 4) { par4Total += s.gross_score; par4Count++; }
      else if (par === 5) { par5Total += s.gross_score; par5Count++; }
    }
  }

  const avgGrossScore = grossScores.length > 0
    ? grossScores.reduce((s, g) => s + g, 0) / grossScores.length
    : null;
  const lowScore  = grossScores.length > 0 ? Math.min(...grossScores) : null;
  const highScore = grossScores.length > 0 ? Math.max(...grossScores) : null;

  return {
    rounds,
    // grossScores is exposed so the Scores tab can derive its summary strip
    // from the same paired data without duplicating the pairing logic.
    grossScores,
    avgGrossScore,
    lowScore,
    highScore,
    avgPuttsPerRound: totalPuttHoles > 0 ? (totalPutts / totalPuttHoles) * 18  : null,
    puttDist: { one: putts1, two: putts2, three: putts3, fourPlus: putts4Plus },
    avgPuttMadeDistance: puttMadeCount > 0 ? puttMadeTotal / puttMadeCount : null,
    longestPuttMade: puttMadeCount > 0 ? puttMadeLongest : null,
    girPercent:       greensTotal > 0   ? (greensHit / greensTotal) * 100     : null,
    firPercent:       fairwaysTotal > 0 ? (fairwaysHit / fairwaysTotal) * 100 : null,
    firMiss: { left: firMissLeft, right: firMissRight, short: firMissShort, long: firMissLong },
    firTotal: fairwaysTotal,
    girMiss: { left: girMissLeft, right: girMissRight, short: girMissShort, long: girMissLong },
    girTotal: greensTotal,
    girNaPercent: girTrackedTotal > 0 ? (girNaCount / girTrackedTotal) * 100 : null,
    proximityRows: Array.from(proximityBuckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([band, { total, count }]) => ({
        label: `${band}–${band + 19} yds`,
        value: `${(total / count).toFixed(1)} ft`,
      })),
    birdiesOrBetter, parsCount, bogeysCount, doublesPlus,
    avgPar3: par3Count > 0 ? par3Total / par3Count : null,
    avgPar4: par4Count > 0 ? par4Total / par4Count : null,
    avgPar5: par5Count > 0 ? par5Total / par5Count : null,
  };
}
