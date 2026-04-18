// app/(tabs)/stats.tsx
// Stats screen — personal scoring stats for the logged-in user.
//
// Two inner tabs (Stats | Scores) share a top-level period filter:
//   Stats  — aggregated stat sections (Scoring, Driving, Approach, Putting, Recovery)
//   Scores — scoring history line chart + per-round score list
//
// Each score card in the Scores tab exposes two actions:
//   Stats     → RoundStatsModal: per-round stat sections (same structure as the Stats tab)
//   Scorecard → RoundScorecardModal: read-only hole-by-hole grid for the current user only
//
// Data flow:
//   1. GET /api/v1/rounds fetches all rounds the user is in (cached with the Rounds tab)
//   2. Completed rounds are filtered to the active period
//   3. Scorecards for those rounds are fetched in parallel via useQueries
//   4. caller_user_id (DB UUID returned by the API) identifies the caller's player entry

import { useState, useMemo, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  RefreshControl,
} from "react-native";
import { useAuth } from "@clerk/clerk-expo";
import { useQuery, useQueries } from "@tanstack/react-query";
import Ionicons from "@expo/vector-icons/Ionicons";
import Svg, { Path } from "react-native-svg";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import { apiFetch } from "@/utils/api";
import ModalHeader from "@/components/ModalHeader";
import type { Scorecard, ScorecardPlayer, ScorecardHole } from "@/types/scorecard";

// ─── Types ────────────────────────────────────────────────────────────────────

// Minimal shape from GET /api/v1/rounds — only the fields we need here.
type RoundSummary = {
  id: string;
  name: string;
  event_name: string;
  scheduled_date: string; // "YYYY-MM-DD"
  status: string;
  course_name: string;
  tee_name: string;
  tee_par: number;
  course_rating: number;
  slope_rating: number;
};

// FilterValue is a discriminated string: "last20", "all", or a 4-digit year like "2026".
// Using plain string avoids the S6571 Sonar warning (specific literals overridden by string).
type FilterValue = string;

type InnerTab = "stats" | "scores";

// ─── Stats computation ────────────────────────────────────────────────────────

// findMyPlayer locates the caller's ScorecardPlayer entry using the DB UUID the
// server returns in caller_user_id — Clerk's user.id is a different format.
function findMyPlayer(sc: Scorecard): ScorecardPlayer | undefined {
  for (const group of sc.groups) {
    const p = group.players.find((pl) => pl.user_id === sc.caller_user_id);
    if (p) return p;
  }
  return undefined;
}

// buildRoundStats computes per-hole stats for one player in a single round.
function buildRoundStats(player: ScorecardPlayer, holes: ScorecardHole[]) {
  const holeMap = new Map(holes.map((h) => [h.hole_number, h.par]));

  let birdies = 0, pars = 0, bogeys = 0, doubles = 0;
  for (const s of player.scores) {
    const par = holeMap.get(s.hole_number);
    if (par == null) continue;
    const diff = s.gross_score - par;
    if (diff <= -1)     birdies++;
    else if (diff === 0) pars++;
    else if (diff === 1) bogeys++;
    else                 doubles++;
  }

  const validPutts  = player.hole_stats.filter((hs) => hs.putts !== null);
  const totalPutts  = validPutts.reduce((sum, hs) => sum + (hs.putts ?? 0), 0);
  const greensHit   = player.hole_stats.filter((hs) => hs.gir === "hit").length;
  const greensTotal = player.hole_stats.filter((hs) => hs.gir !== null && hs.gir !== "na").length;
  const fairwaysHit   = player.hole_stats.filter((hs) => hs.fir === true).length;
  const fairwaysTotal = player.hole_stats.filter((hs) => hs.fir !== null).length;

  return {
    birdies, pars, bogeys, doubles,
    totalPutts:     validPutts.length > 0 ? totalPutts : null,
    puttsTracked:   validPutts.length,
    greensHit,   greensTotal,
    fairwaysHit, fairwaysTotal,
  };
}

// buildMyStats aggregates the caller's personal stats across a set of scorecards.
function buildMyStats(scorecards: Scorecard[]) {
  let rounds = 0;
  let totalGross = 0;
  let grossCount = 0;
  let totalPutts = 0;
  let puttRounds = 0;
  let greensHit = 0;
  let greensTotal = 0;
  let fairwaysHit = 0;
  let fairwaysTotal = 0;

  // Scoring distribution counters for the pie chart.
  let birdiesOrBetter = 0;
  let parsCount = 0;
  let bogeysCount = 0;
  let doublesPlus = 0;

  // Par-specific score accumulators for avg score by par.
  let par3Total = 0, par3Count = 0;
  let par4Total = 0, par4Count = 0;
  let par5Total = 0, par5Count = 0;

  for (const sc of scorecards) {
    const holeMap = new Map(sc.holes.map((h) => [h.hole_number, h.par]));
    const player = findMyPlayer(sc);
    if (!player) continue;

    rounds++;

    if (player.total_gross !== null) {
      totalGross += player.total_gross;
      grossCount++;
    }

    const validPutts = player.hole_stats.filter((hs) => hs.putts !== null);
    if (validPutts.length > 0) {
      totalPutts += validPutts.reduce((sum, hs) => sum + (hs.putts ?? 0), 0);
      puttRounds++;
    }

    // GIR: exclude "na" holes (par-3s don't have fairways but do track greens).
    greensHit   += player.hole_stats.filter((hs) => hs.gir === "hit").length;
    greensTotal += player.hole_stats.filter((hs) => hs.gir !== null && hs.gir !== "na").length;

    fairwaysHit   += player.hole_stats.filter((hs) => hs.fir === true).length;
    fairwaysTotal += player.hole_stats.filter((hs) => hs.fir !== null).length;

    // Per-score loop: scoring distribution and par-type averages.
    for (const s of player.scores) {
      const par = holeMap.get(s.hole_number);
      if (par == null) continue;
      const diff = s.gross_score - par;

      if (diff <= -1)     birdiesOrBetter++;
      else if (diff === 0) parsCount++;
      else if (diff === 1) bogeysCount++;
      else                 doublesPlus++;

      if (par === 3)      { par3Total += s.gross_score; par3Count++; }
      else if (par === 4) { par4Total += s.gross_score; par4Count++; }
      else if (par === 5) { par5Total += s.gross_score; par5Count++; }
    }
  }

  return {
    rounds,
    avgGrossScore:    grossCount > 0     ? totalGross / grossCount            : null,
    avgPuttsPerRound: puttRounds > 0    ? totalPutts / puttRounds            : null,
    girPercent:       greensTotal > 0   ? (greensHit / greensTotal) * 100    : null,
    firPercent:       fairwaysTotal > 0 ? (fairwaysHit / fairwaysTotal) * 100 : null,
    birdiesOrBetter, parsCount, bogeysCount, doublesPlus,
    avgPar3: par3Count > 0 ? par3Total / par3Count : null,
    avgPar4: par4Count > 0 ? par4Total / par4Count : null,
    avgPar5: par5Count > 0 ? par5Total / par5Count : null,
  };
}

// ─── Scorecard helpers ────────────────────────────────────────────────────────

// toPar formats a gross-to-par difference as "+N", "-N", or "E".
function toPar(gross: number, par: number): string {
  const diff = gross - par;
  if (diff === 0) return "E";
  return diff > 0 ? `+${diff}` : `${diff}`;
}

// scoreTextColor returns a hardcoded categorical color class based on result vs par.
// Score colors encode meaning (eagle/birdie/par/bogey/double+), so they must NOT use
// theme tokens — the color IS the signal. See CLAUDE.md categorical color rule.
function scoreTextColor(gross: number, par: number): string {
  const diff = gross - par;
  if (diff <= -2) return "text-yellow-500"; // eagle or better
  if (diff === -1) return "text-green-600"; // birdie
  if (diff === 1)  return "text-amber-500"; // bogey
  if (diff >= 2)   return "text-red-500";   // double bogey or worse
  return ""; // par — inherit theme color
}

// ─── Sub-components ───────────────────────────────────────────────────────────

// StatCard renders a labeled group of stat rows.
// Each row has a label on the left and a value on the right.
// dim=true greys out the value when no data is available.
function StatCard({
  label,
  rows,
}: Readonly<{
  label: string;
  rows: { label: string; value: string; dim?: boolean }[];
}>) {
  const t = useTheme();
  return (
    <View className={`${t.surface} rounded-2xl border ${t.border} p-4 mb-3`}>
      <Text className={`text-xs font-bold uppercase tracking-widest ${t.textTertiary} mb-1`}>
        {label}
      </Text>
      {rows.map((row) => (
        <View key={row.label} className={`flex-row items-center justify-between py-2.5 border-b ${t.divider}`}>
          <Text className={`text-sm ${t.textSecondary}`}>{row.label}</Text>
          <Text className={`text-sm font-semibold ${row.dim ? t.textTertiary : t.textPrimary}`}>
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ScoringPieChart renders a donut chart showing hole outcome distribution across
// all scored holes. Segments use categorical colors that encode scoring meaning,
// not theme tokens. Segments with zero holes are omitted to keep the chart clean.
function ScoringPieChart({
  birdiesOrBetter,
  pars,
  bogeys,
  doublesPlus,
}: Readonly<{
  birdiesOrBetter: number;
  pars: number;
  bogeys: number;
  doublesPlus: number;
}>) {
  const t = useTheme();
  const total = birdiesOrBetter + pars + bogeys + doublesPlus;
  if (total === 0) return null;

  const SIZE = 160;
  const CX   = SIZE / 2;
  const CY   = SIZE / 2;
  const R    = 66; // outer radius
  const IR   = 40; // inner radius (donut hole)

  // Categorical colors — color encodes scoring meaning, not theme state.
  const allSlices = [
    { value: birdiesOrBetter, color: "#16a34a", label: "Birdie+" },
    { value: pars,             color: "#3b82f6", label: "Par"     },
    { value: bogeys,           color: "#f59e0b", label: "Bogey"   },
    { value: doublesPlus,      color: "#ef4444", label: "Double+" },
  ];
  // Only include slices that have at least one hole — zero-value arcs are invisible
  // but can cause SVG rendering artifacts.
  const slices = allSlices.filter((s) => s.value > 0);

  function toXY(angle: number, radius: number) {
    return { x: CX + radius * Math.cos(angle), y: CY + radius * Math.sin(angle) };
  }

  // Build a donut arc path. When the sweep is nearly 2π (one segment dominates),
  // clamp to avoid the degenerate case where the arc's start and end points coincide.
  function arcPath(startAngle: number, sweep: number): string {
    const clampedSweep = Math.min(sweep, 2 * Math.PI - 0.001);
    const endAngle = startAngle + clampedSweep;
    const os = toXY(startAngle, R);
    const oe = toXY(endAngle,   R);
    const is = toXY(startAngle, IR);
    const ie = toXY(endAngle,   IR);
    const large = clampedSweep > Math.PI ? 1 : 0;
    return [
      `M ${os.x.toFixed(2)} ${os.y.toFixed(2)}`,
      `A ${R} ${R} 0 ${large} 1 ${oe.x.toFixed(2)} ${oe.y.toFixed(2)}`,
      `L ${ie.x.toFixed(2)} ${ie.y.toFixed(2)}`,
      `A ${IR} ${IR} 0 ${large} 0 ${is.x.toFixed(2)} ${is.y.toFixed(2)}`,
      "Z",
    ].join(" ");
  }

  // Start at the top of the circle (–π/2) and sweep clockwise.
  let angle = -Math.PI / 2;
  const paths = slices.map((s) => {
    const sweep = (s.value / total) * 2 * Math.PI;
    const d = arcPath(angle, sweep);
    angle += sweep;
    return { ...s, d };
  });

  return (
    <View className={`${t.surface} rounded-2xl border ${t.border} p-4 mb-3`}>
      <Text className={`text-xs font-bold uppercase tracking-widest ${t.textTertiary} mb-3`}>
        Scoring Distribution
      </Text>
      <View className="items-center mb-3">
        <Svg width={SIZE} height={SIZE}>
          {paths.map((s) => (
            <Path key={s.label} d={s.d} fill={s.color} />
          ))}
        </Svg>
      </View>
      {/* Legend: one row per category, label on left, "pct% (n)" on right */}
      <View className="gap-2">
        {allSlices.map((s) => {
          const pct = Math.round((s.value / total) * 100);
          return (
            <View key={s.label} className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-2">
                {/* eslint-disable-next-line react-native/no-inline-styles */}
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: s.color }} />
                <Text className={`text-sm ${t.textSecondary}`}>{s.label}</Text>
              </View>
              <Text className={`text-sm font-semibold ${s.value === 0 ? t.textTertiary : t.textPrimary}`}>
                {pct}% ({s.value})
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// formatRunningDiff formats a cumulative to-par differential for display.
// Returns "—" when no holes are scored yet, "E" for even, "+N" or "-N" otherwise.
function formatRunningDiff(diff: number | undefined): string {
  if (diff === undefined) return "—";
  if (diff === 0) return "E";
  return diff > 0 ? `+${diff}` : `${diff}`;
}

// runningDiffColor returns the appropriate NativeWind color class for a running differential.
function runningDiffColor(diff: number | undefined, neutralClass: string): string {
  if (diff === undefined || diff === 0) return neutralClass;
  return diff < 0 ? "text-green-600" : "text-red-500";
}

// HoleTableRow renders a single hole inside the scorecard grid.
// runningDiff is the cumulative to-par total from hole 1 through this hole —
// undefined when the player hasn't scored this hole yet.
function HoleTableRow({
  hole,
  gross,
  runningDiff,
}: Readonly<{
  hole: ScorecardHole;
  gross: number | undefined;
  runningDiff: number | undefined;
}>) {
  const t = useTheme();
  const hasScore   = gross !== undefined;
  const colorClass = hasScore ? scoreTextColor(gross, hole.par) : "";
  const runningText  = formatRunningDiff(runningDiff);
  const runningColor = runningDiffColor(runningDiff, t.textTertiary);

  return (
    <View className={`flex-row items-center py-2.5 border-b ${t.border}`}>
      <Text className={`w-10 text-sm font-semibold ${t.textSecondary}`}>
        {hole.hole_number}
      </Text>
      <Text className={`w-10 text-sm text-center ${t.textSecondary}`}>
        {hole.par}
      </Text>
      <Text className={`flex-1 text-sm font-bold text-center ${colorClass || t.textPrimary}`}>
        {hasScore ? gross : "—"}
      </Text>
      <Text className={`w-12 text-sm text-right font-semibold ${runningColor}`}>
        {runningText}
      </Text>
    </View>
  );
}

// formatTotalDiff formats a hole total's gross-vs-par difference for display.
function formatTotalDiff(diff: number | null): string {
  if (diff === null) return "—";
  if (diff === 0) return "E";
  return diff > 0 ? `+${diff}` : `${diff}`;
}

// totalDiffColor returns the NativeWind color class for a totals row's to-par display.
function totalDiffColor(diff: number | null, neutralClass: string): string {
  if (diff === null || diff === 0) return neutralClass;
  return diff < 0 ? "text-green-600" : "text-red-500";
}

// HoleTotalsRow renders the OUT / IN / TOT summary row inside the scorecard grid.
function HoleTotalsRow({
  label,
  par,
  gross,
}: Readonly<{
  label: string;
  par: number;
  gross: number | null;
}>) {
  const t = useTheme();
  // gross === null means not all holes scored yet — show "—" for the diff.
  const diff       = gross === null ? null : gross - par;
  const toParText  = formatTotalDiff(diff);
  const toParColor = totalDiffColor(diff, t.textTertiary);

  return (
    <View className={`flex-row items-center py-2.5 px-1 ${t.surfaceSunken} rounded-lg my-1`}>
      <Text className={`w-10 text-xs font-bold uppercase ${t.textTertiary}`}>{label}</Text>
      <Text className={`w-10 text-sm font-bold text-center ${t.textPrimary}`}>{par}</Text>
      <Text className={`flex-1 text-sm font-bold text-center ${t.textPrimary}`}>
        {gross ?? "—"}
      </Text>
      <Text className={`w-12 text-sm font-bold text-right ${toParColor}`}>{toParText}</Text>
    </View>
  );
}

// RoundStatsModal shows per-round stats for the current user.
// scorecard is pre-loaded by the parent before opening this modal.
function RoundStatsModal({
  round,
  scorecard,
  onClose,
}: Readonly<{
  round: RoundSummary;
  scorecard: Scorecard | undefined;
  onClose: () => void;
}>) {
  const t = useTheme();

  const player     = scorecard ? findMyPlayer(scorecard) : undefined;
  const roundStats = player && scorecard ? buildRoundStats(player, scorecard.holes) : null;

  const [year, month, day] = round.scheduled_date.split("-").map(Number);
  const date = new Date(year, month - 1, day).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  // Format a percentage with fraction: "45% (5/11)" — "—" when not tracked.
  const fmtPct = (hit: number, total: number) =>
    total > 0 ? `${Math.round((hit / total) * 100)}% (${hit}/${total})` : "—";

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View className={`flex-1 ${t.screen}`}>
        <View className="pt-14 px-5">
          <ModalHeader title="Round Stats" onClose={onClose} />
        </View>
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Context card */}
          <View className={`${t.surface} rounded-2xl border ${t.border} p-4 mb-5`}>
            <Text className={`text-base font-bold ${t.textPrimary}`} numberOfLines={2}>
              {round.event_name} – {round.name}
            </Text>
            <Text className={`text-xs ${t.textTertiary} mt-0.5 mb-3`}>{date}</Text>
            <View className={`pt-3 border-t ${t.border} flex-row flex-wrap gap-x-4 gap-y-1`}>
              <Text className={`text-xs font-semibold ${t.textSecondary}`}>{round.course_name}</Text>
              <Text className={`text-xs ${t.textSecondary}`}>
                Tees: <Text className={`font-semibold ${t.textPrimary}`}>{round.tee_name}</Text>
              </Text>
              <Text className={`text-xs ${t.textSecondary}`}>
                Par: <Text className={`font-semibold ${t.textPrimary}`}>{round.tee_par}</Text>
              </Text>
              <Text className={`text-xs ${t.textSecondary}`}>
                Rating: <Text className={`font-semibold ${t.textPrimary}`}>{round.course_rating.toFixed(1)}</Text>
              </Text>
              <Text className={`text-xs ${t.textSecondary}`}>
                Slope: <Text className={`font-semibold ${t.textPrimary}`}>{round.slope_rating}</Text>
              </Text>
            </View>
          </View>

          {roundStats ? (
            <>
              <StatCard
                label="Scoring"
                rows={[
                  { label: "Birdies or Better", value: roundStats.birdies > 0 ? roundStats.birdies.toString() : "—", dim: roundStats.birdies === 0 },
                  { label: "Pars",    value: roundStats.pars.toString()    },
                  { label: "Bogeys",  value: roundStats.bogeys.toString()  },
                  { label: "Double+", value: roundStats.doubles > 0 ? roundStats.doubles.toString() : "—", dim: roundStats.doubles === 0 },
                ]}
              />
              <StatCard
                label="Driving"
                rows={[
                  { label: "Fairways Hit", value: fmtPct(roundStats.fairwaysHit, roundStats.fairwaysTotal), dim: roundStats.fairwaysTotal === 0 },
                ]}
              />
              <StatCard
                label="Approach"
                rows={[
                  { label: "Greens in Regulation", value: fmtPct(roundStats.greensHit, roundStats.greensTotal), dim: roundStats.greensTotal === 0 },
                ]}
              />
              <StatCard
                label="Putting"
                rows={[
                  { label: "Total Putts",      value: roundStats.totalPutts === null ? "—" : roundStats.totalPutts.toString(), dim: roundStats.totalPutts === null },
                  { label: "Avg Putts / Hole", value: (roundStats.totalPutts !== null && roundStats.puttsTracked > 0) ? (roundStats.totalPutts / roundStats.puttsTracked).toFixed(1) : "—", dim: roundStats.totalPutts === null },
                ]}
              />
            </>
          ) : (
            <View className={`${t.surface} rounded-2xl border ${t.border} p-8 items-center gap-2`}>
              <Ionicons name="bar-chart-outline" size={36} color={t.colors.tabBarInactive} />
              <Text className={`text-sm text-center ${t.textSecondary}`}>
                No stats recorded for this round.
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// RoundScorecardModal shows a read-only hole-by-hole grid for the current user's
// scores only. Holes are grouped into front 9 / back 9 with OUT, IN, and TOT totals.
function RoundScorecardModal({
  round,
  scorecard,
  onClose,
}: Readonly<{
  round: RoundSummary;
  scorecard: Scorecard;
  onClose: () => void;
}>) {
  const t = useTheme();

  const player = findMyPlayer(scorecard);

  // Build a hole_number → gross_score lookup from the player's scores.
  const scoreMap = useMemo(() => {
    if (!player) return new Map<number, number>();
    return new Map(player.scores.map((s) => [s.hole_number, s.gross_score]));
  }, [player]);

  // Sort holes by hole_number so front/back 9 splits are correct regardless of API order.
  const sortedHoles = useMemo(
    () => [...scorecard.holes].sort((a, b) => a.hole_number - b.hole_number),
    [scorecard.holes]
  );

  const front9 = sortedHoles.filter((h) => h.hole_number <= 9);
  const back9  = sortedHoles.filter((h) => h.hole_number >= 10);

  // Build a hole_number → cumulative to-par total map.
  // Iterates through all holes in order, accumulating (gross - par) only while every
  // preceding hole has a score. Stops accumulating once a hole is unscored so the
  // running total doesn't skip ahead.
  const runningDiffMap = useMemo(() => {
    const map = new Map<number, number>();
    let cumulative = 0;
    for (const hole of sortedHoles) {
      const gross = scoreMap.get(hole.hole_number);
      if (gross === undefined) break; // stop at first unscored hole
      cumulative += gross - hole.par;
      map.set(hole.hole_number, cumulative);
    }
    return map;
  }, [sortedHoles, scoreMap]);

  // Total par and gross for each nine, falling back to null when scores are missing.
  function nineTotal(holes: ScorecardHole[]) {
    const par = holes.reduce((s, h) => s + h.par, 0);
    const allScored = holes.every((h) => scoreMap.has(h.hole_number));
    const gross = allScored
      ? holes.reduce((s, h) => s + (scoreMap.get(h.hole_number) ?? 0), 0)
      : null;
    return { par, gross };
  }

  const frontTotals = nineTotal(front9);
  const backTotals  = nineTotal(back9);
  const totalPar    = frontTotals.par + backTotals.par;
  const totalGross  =
    frontTotals.gross !== null && backTotals.gross !== null
      ? frontTotals.gross + backTotals.gross
      : null;

  const [year, month, day] = round.scheduled_date.split("-").map(Number);
  const date = new Date(year, month - 1, day).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View className={`flex-1 ${t.screen}`}>
        <View className="pt-14 px-5">
          <ModalHeader title="Scorecard" onClose={onClose} />
        </View>
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Context */}
          <Text className={`text-base font-bold ${t.textPrimary}`} numberOfLines={2}>
            {round.event_name} – {round.name}
          </Text>
          <Text className={`text-xs ${t.textTertiary} mt-0.5 mb-1`}>{date}</Text>
          <Text className={`text-xs ${t.textSecondary} mb-5`}>
            {round.course_name} · {round.tee_name} · Par {round.tee_par} · {round.course_rating.toFixed(1)}/{round.slope_rating}
          </Text>

          {scorecard.holes.length === 0 ? (
            <View className={`${t.surface} rounded-2xl border ${t.border} p-8 items-center gap-2`}>
              <Ionicons name="golf-outline" size={36} color={t.colors.tabBarInactive} />
              <Text className={`text-sm ${t.textSecondary} text-center`}>
                No hole data available for this course tee.
              </Text>
            </View>
          ) : (
            <View className={`${t.surface} rounded-2xl border ${t.border} p-4`}>
              {/* Column headers */}
              <View className="flex-row pb-2 mb-1">
                <Text className={`w-10 text-xs font-bold uppercase ${t.textTertiary}`}>Hole</Text>
                <Text className={`w-10 text-xs font-bold uppercase text-center ${t.textTertiary}`}>Par</Text>
                <Text className={`flex-1 text-xs font-bold uppercase text-center ${t.textTertiary}`}>Score</Text>
                <Text className={`w-12 text-xs font-bold uppercase text-right ${t.textTertiary}`}>+/-</Text>
              </View>

              {/* Front 9 */}
              {front9.map((hole) => (
                <HoleTableRow
                  key={hole.hole_number}
                  hole={hole}
                  gross={scoreMap.get(hole.hole_number)}
                  runningDiff={runningDiffMap.get(hole.hole_number)}
                />
              ))}
              {front9.length > 0 && (
                <HoleTotalsRow label="OUT" par={frontTotals.par} gross={frontTotals.gross} />
              )}

              {/* Back 9 */}
              {back9.map((hole) => (
                <HoleTableRow
                  key={hole.hole_number}
                  hole={hole}
                  gross={scoreMap.get(hole.hole_number)}
                  runningDiff={runningDiffMap.get(hole.hole_number)}
                />
              ))}
              {back9.length > 0 && (
                <HoleTotalsRow label="IN" par={backTotals.par} gross={backTotals.gross} />
              )}

              {/* Total */}
              <HoleTotalsRow label="TOT" par={totalPar} gross={totalGross} />
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ScoreRow renders one round's card in the Scores tab list with Stats and Scorecard
// action buttons. The scorecard prop may be undefined while still loading.
function ScoreRow({
  round,
  scorecard,
  onStatsPress,
  onScorecardPress,
}: Readonly<{
  round: RoundSummary;
  scorecard: Scorecard | undefined;
  onStatsPress: () => void;
  onScorecardPress: () => void;
}>) {
  const t = useTheme();

  const player = scorecard ? findMyPlayer(scorecard) : undefined;
  const scoreDisplay = String(player?.total_gross ?? "—");

  // Parse the date string as local time so it doesn't shift by timezone offset.
  const [year, month, day] = round.scheduled_date.split("-").map(Number);
  const date = new Date(year, month - 1, day).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const scorecardReady = scorecard !== undefined;

  return (
    <View className={`${t.surface} rounded-2xl border ${t.border} p-4 mb-3`}>
      {/* Title row: "Event Name – Round Name" + gross score */}
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className={`text-sm font-bold ${t.textPrimary}`} numberOfLines={1}>
            {round.event_name} – {round.name}
          </Text>
          <Text className={`text-xs ${t.textTertiary} mt-0.5`}>{date}</Text>
        </View>
        <Text className={`text-2xl font-bold ${t.textPrimary}`}>{scoreDisplay}</Text>
      </View>

      {/* Course detail row */}
      <View className={`mt-3 pt-3 border-t ${t.border} flex-row flex-wrap gap-x-4 gap-y-1`}>
        <Text className={`text-xs font-semibold ${t.textSecondary}`}>{round.course_name}</Text>
        <Text className={`text-xs ${t.textSecondary}`}>
          Tees: <Text className={`font-semibold ${t.textPrimary}`}>{round.tee_name}</Text>
        </Text>
        <Text className={`text-xs ${t.textSecondary}`}>
          Par: <Text className={`font-semibold ${t.textPrimary}`}>{round.tee_par}</Text>
        </Text>
        <Text className={`text-xs ${t.textSecondary}`}>
          Rating: <Text className={`font-semibold ${t.textPrimary}`}>{round.course_rating.toFixed(1)}</Text>
        </Text>
        <Text className={`text-xs ${t.textSecondary}`}>
          Slope: <Text className={`font-semibold ${t.textPrimary}`}>{round.slope_rating}</Text>
        </Text>
      </View>

      {/* Action buttons */}
      <View className={`mt-3 pt-3 border-t ${t.border} flex-row gap-2`}>
        <TouchableOpacity
          className={`flex-1 flex-row items-center justify-center gap-1.5 py-2 rounded-xl border ${t.border} ${t.surface} ${scorecardReady ? "" : "opacity-40"}`}
          onPress={onStatsPress}
          disabled={!scorecardReady}
          activeOpacity={0.75}
        >
          <Ionicons name="bar-chart-outline" size={14} color={t.colors.tabBarInactive} />
          <Text className={`text-sm font-semibold ${t.textSecondary}`}>Stats</Text>
        </TouchableOpacity>
        <TouchableOpacity
          className={`flex-1 flex-row items-center justify-center gap-1.5 py-2 rounded-xl border ${t.border} ${t.surface} ${scorecardReady ? "" : "opacity-40"}`}
          onPress={onScorecardPress}
          disabled={!scorecardReady}
          activeOpacity={0.75}
        >
          <Ionicons name="list-outline" size={14} color={t.colors.tabBarInactive} />
          <Text className={`text-sm font-semibold ${t.textSecondary}`}>Scorecard</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Constants ────────────────────────────────────────────────────────────────

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function StatsScreen() {
  const { getToken } = useAuth();
  const t = useTheme();

  const [activeFilter, setActiveFilter] = useState<FilterValue>("last20");
  const [innerTab, setInnerTab] = useState<InnerTab>("stats");
  const [refreshing, setRefreshing] = useState(false);

  // Which round is currently open in a modal, and which modal is showing.
  const [selectedRound, setSelectedRound] = useState<RoundSummary | null>(null);
  const [openModal, setOpenModal] = useState<"stats" | "scorecard" | null>(null);

  // GET /api/v1/rounds is shared with the Rounds tab — React Query serves it from cache.
  const { data: allRounds, isLoading: roundsLoading, isError: roundsError, refetch } = useQuery<RoundSummary[]>({
    queryKey: ["rounds"],
    queryFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/rounds`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to fetch rounds: ${res.status}`);
      return res.json();
    },
  });

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  // Only completed rounds have scorecards worth aggregating.
  // completedRounds is ordered by scheduled_date DESC (API order).
  const completedRounds = useMemo(
    () => (allRounds ?? []).filter((r) => r.status === "completed"),
    [allRounds]
  );

  // Derive available calendar years in descending order from the completed round dates.
  const availableYears = useMemo(() => {
    const years = [...new Set(completedRounds.map((r) => r.scheduled_date.slice(0, 4)))];
    return years.sort((a, b) => b.localeCompare(a));
  }, [completedRounds]);

  // Filter pill options: Last 20 | <year> … | All Time.
  const filterOptions = useMemo<{ value: FilterValue; label: string }[]>(
    () => [
      { value: "last20", label: "Last 20" },
      ...availableYears.map((y) => ({ value: y, label: y })),
      { value: "all", label: "All Time" },
    ],
    [availableYears]
  );

  // Which completed rounds fall inside the active filter?
  const filteredRounds = useMemo(() => {
    if (activeFilter === "last20") return completedRounds.slice(0, 20);
    if (activeFilter === "all")    return completedRounds;
    return completedRounds.filter((r) => r.scheduled_date.startsWith(activeFilter));
  }, [completedRounds, activeFilter]);

  // Fetch scorecards for the filtered rounds. React Query caches per round ID,
  // so switching filters reuses previously loaded results without extra requests.
  const scorecardQueries = useQueries({
    queries: filteredRounds.map((round) => ({
      queryKey: ["scorecard", round.id],
      queryFn: async () => {
        const token = await getToken();
        const res = await apiFetch(`${API_URL}/api/v1/rounds/${round.id}/scorecard`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`Failed to fetch scorecard: ${res.status}`);
        return res.json() as Promise<Scorecard>;
      },
      enabled: filteredRounds.length > 0,
    })),
  });

  const scorecardsLoading = scorecardQueries.some((q) => q.isLoading);
  const scorecards = scorecardQueries
    .map((q) => q.data)
    .filter((sc): sc is Scorecard => sc !== undefined);

  const stats = useMemo(() => buildMyStats(scorecards), [scorecards]);

  // Scoring summary for the Scores tab: avg, high, and low gross scores across
  // the filtered rounds. Only rounds where the player has a complete total_gross count.
  const scoringSummary = useMemo(() => {
    const grossScores = scorecards
      .map((sc) => findMyPlayer(sc)?.total_gross)
      .filter((g): g is number => g !== null && g !== undefined);
    if (grossScores.length === 0) return null;
    const avg = grossScores.reduce((s, g) => s + g, 0) / grossScores.length;
    return {
      avg,
      low:  Math.min(...grossScores),
      high: Math.max(...grossScores),
    };
  }, [scorecards]);

  // Look up the loaded scorecard for whichever round has a modal open.
  const selectedScorecard = selectedRound
    ? scorecards.find((sc) => sc.round_id === selectedRound.id)
    : undefined;

  function closeModal() {
    setOpenModal(null);
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  if (roundsLoading) {
    return (
      <View className={`flex-1 items-center justify-center ${t.screen}`}>
        <ActivityIndicator size="large" color={t.colors.tabBarActive} />
      </View>
    );
  }

  if (roundsError) {
    return (
      <View className={`flex-1 items-center justify-center gap-3 ${t.screen}`}>
        <Ionicons name="alert-circle-outline" size={48} color="#dc2626" />
        <Text className={`font-semibold ${t.textPrimary}`}>Failed to load stats</Text>
      </View>
    );
  }

  // Shared empty state: no completed rounds at all.
  const noRoundsEver = completedRounds.length === 0;
  // Empty state for the selected filter period.
  const noRoundsInPeriod = !noRoundsEver && filteredRounds.length === 0;
  // Period suffix appended to round-count labels — if/else avoids a nested ternary.
  let periodLabel = ` · ${activeFilter}`;
  if (activeFilter === "last20") periodLabel = " · Last 20";
  else if (activeFilter === "all") periodLabel = " · All Time";

  return (
    <View className={`flex-1 ${t.screen}`}>
      {/* Per-round modals — rendered outside the ScrollView so they overlay the full screen */}
      {selectedRound && openModal === "stats" && (
        <RoundStatsModal round={selectedRound} scorecard={selectedScorecard} onClose={closeModal} />
      )}
      {selectedRound && openModal === "scorecard" && selectedScorecard && (
        <RoundScorecardModal
          round={selectedRound}
          scorecard={selectedScorecard}
          onClose={closeModal}
        />
      )}

      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            colors={[t.colors.tabBarActive]}
            tintColor={t.colors.tabBarActive}
          />
        }
      >
        {/* Page header */}
        <View className="px-5 pt-14 pb-3">
          <Text className={`text-2xl font-bold ${t.textPrimary}`}>My Stats</Text>
        </View>

        {/* Filter pill bar — scrolls horizontally when years accumulate */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 20, gap: 8, paddingBottom: 16 }}
        >
          {filterOptions.map((opt) => {
            const isActive = activeFilter === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                className={`rounded-full px-4 py-2 border ${
                  isActive ? `${t.primaryBg} border-transparent` : `${t.surface} ${t.border}`
                }`}
                onPress={() => setActiveFilter(opt.value)}
                activeOpacity={0.8}
              >
                <Text className={`text-sm font-semibold ${isActive ? "text-white" : t.textSecondary}`}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Inner tab bar: Stats | Scores */}
        <View className="flex-row gap-2 px-5 mb-5">
          {(["stats", "scores"] as InnerTab[]).map((tab) => {
            const isActive = innerTab === tab;
            return (
              <TouchableOpacity
                key={tab}
                className={`flex-1 rounded-full py-2 items-center border ${
                  isActive ? `${t.primaryBg} border-transparent` : `${t.surface} ${t.border}`
                }`}
                onPress={() => setInnerTab(tab)}
                activeOpacity={0.8}
              >
                <Text className={`text-sm font-semibold ${isActive ? "text-white" : t.textSecondary}`}>
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View className="px-5">
          {noRoundsEver ? (
            <View className={`${t.surface} rounded-2xl border ${t.border} p-8 items-center gap-2`}>
              <Ionicons name="bar-chart-outline" size={40} color={t.colors.tabBarInactive} />
              <Text className={`text-base font-semibold ${t.textPrimary}`}>No stats yet</Text>
              <Text className={`text-sm text-center ${t.textSecondary}`}>
                Complete a round to start tracking your stats.
              </Text>
            </View>
          ) : noRoundsInPeriod ? (
            <View className={`${t.surface} rounded-2xl border ${t.border} p-8 items-center gap-2`}>
              <Ionicons name="calendar-outline" size={40} color={t.colors.tabBarInactive} />
              <Text className={`text-base font-semibold ${t.textPrimary}`}>
                No rounds in {activeFilter}
              </Text>
              <Text className={`text-sm text-center ${t.textSecondary}`}>
                Select a different period to see your stats.
              </Text>
            </View>
          ) : scorecardsLoading ? (
            <View className="py-16 items-center">
              <ActivityIndicator size="large" color={t.colors.tabBarActive} />
            </View>
          ) : innerTab === "stats" ? (
            <>
              {/* Context label: "5 rounds · 2026" */}
              <Text className={`text-xs font-semibold uppercase tracking-widest mb-4 ${t.textTertiary}`}>
                {stats.rounds} round{stats.rounds === 1 ? "" : "s"}{periodLabel}
              </Text>

              <StatCard
                label="Scoring"
                rows={[
                  { label: "Avg Score",   value: stats.avgGrossScore === null ? "—" : stats.avgGrossScore.toFixed(1), dim: stats.avgGrossScore === null },
                  { label: "Avg (Par 3)", value: stats.avgPar3 === null ? "—" : stats.avgPar3.toFixed(2),             dim: stats.avgPar3 === null },
                  { label: "Avg (Par 4)", value: stats.avgPar4 === null ? "—" : stats.avgPar4.toFixed(2),             dim: stats.avgPar4 === null },
                  { label: "Avg (Par 5)", value: stats.avgPar5 === null ? "—" : stats.avgPar5.toFixed(2),             dim: stats.avgPar5 === null },
                ]}
              />
              <ScoringPieChart
                birdiesOrBetter={stats.birdiesOrBetter}
                pars={stats.parsCount}
                bogeys={stats.bogeysCount}
                doublesPlus={stats.doublesPlus}
              />
              <StatCard
                label="Driving"
                rows={[
                  { label: "Fairways Hit", value: stats.firPercent === null ? "—" : `${stats.firPercent.toFixed(0)}%`, dim: stats.firPercent === null },
                ]}
              />
              <StatCard
                label="Approach"
                rows={[
                  { label: "Greens in Regulation", value: stats.girPercent === null ? "—" : `${stats.girPercent.toFixed(0)}%`, dim: stats.girPercent === null },
                ]}
              />
              <StatCard
                label="Putting"
                rows={[
                  { label: "Avg Putts / Round", value: stats.avgPuttsPerRound === null ? "—" : stats.avgPuttsPerRound.toFixed(1), dim: stats.avgPuttsPerRound === null },
                ]}
              />
            </>
          ) : (
            <>
              {/* Scoring history chart — placeholder until chart library is chosen */}
              <View
                className={`${t.surface} rounded-2xl border ${t.border} items-center justify-center mb-4 gap-2`}
                style={{ height: 180 }}
              >
                <Ionicons name="trending-up-outline" size={36} color={t.colors.tabBarInactive} />
                <Text className={`text-sm ${t.textSecondary}`}>Scoring history chart coming soon</Text>
              </View>

              {/* Per-round score list */}
              <Text className={`text-xs font-semibold uppercase tracking-widest mb-3 ${t.textTertiary}`}>
                {filteredRounds.length} round{filteredRounds.length === 1 ? "" : "s"}{periodLabel}
              </Text>

              {/* Avg / Low / High summary strip */}
              {scoringSummary && (
                <View className={`${t.surface} rounded-2xl border ${t.border} flex-row mb-4`}>
                  <View className="flex-1 items-center py-3">
                    <Text className={`text-xl font-bold ${t.textPrimary}`}>
                      {scoringSummary.avg.toFixed(1)}
                    </Text>
                    <Text className={`text-xs font-semibold uppercase tracking-widest mt-0.5 ${t.textTertiary}`}>
                      Avg
                    </Text>
                  </View>
                  <View className={`w-px ${t.border} border-l`} />
                  <View className="flex-1 items-center py-3">
                    <Text className="text-xl font-bold text-green-600">{scoringSummary.low}</Text>
                    <Text className={`text-xs font-semibold uppercase tracking-widest mt-0.5 ${t.textTertiary}`}>
                      Low
                    </Text>
                  </View>
                  <View className={`w-px ${t.border} border-l`} />
                  <View className="flex-1 items-center py-3">
                    <Text className="text-xl font-bold text-red-500">{scoringSummary.high}</Text>
                    <Text className={`text-xs font-semibold uppercase tracking-widest mt-0.5 ${t.textTertiary}`}>
                      High
                    </Text>
                  </View>
                </View>
              )}
              {filteredRounds.map((round) => (
                <ScoreRow
                  key={round.id}
                  round={round}
                  scorecard={scorecards.find((sc) => sc.round_id === round.id)}
                  onStatsPress={() => {
                    setSelectedRound(round);
                    setOpenModal("stats");
                  }}
                  onScorecardPress={() => {
                    setSelectedRound(round);
                    setOpenModal("scorecard");
                  }}
                />
              ))}
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
