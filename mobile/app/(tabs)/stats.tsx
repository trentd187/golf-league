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
//
// ScoringCard, DirectionalMissCard, and PuttingCard live in components/StatCards.tsx
// so the public user profile screen can reuse the exact same display components.

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
import { useAuth } from "@/hooks/useAuth";
import { useQuery, useQueries } from "@tanstack/react-query";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import { apiFetch } from "@/utils/api";
import { findMyPlayer, buildRoundStats, buildMyStats, buildGirByBand, buildScoreHistory, scoreTextColor } from "@/utils/stats";
import ScoreHistoryChart from "@/components/ScoreHistoryChart";
import ModalHeader from "@/components/ModalHeader";
import { ScoringCard, DirectionalMissCard, PuttingCard } from "@/components/StatCards";
// import HandicapSection from "@/components/HandicapSection"; // hidden pending GHIN review
import type { Scorecard, ScorecardHole } from "@/types/scorecard"; // UserHandicapStats unused until GHIN integrated

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

// ─── Sub-components ───────────────────────────────────────────────────────────

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

  const player        = scorecard ? findMyPlayer(scorecard) : undefined;
  const roundStats    = player && scorecard ? buildRoundStats(player, scorecard.holes) : null;
  const roundGirBands = scorecard ? buildGirByBand([scorecard]) : [];

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
              <ScoringCard
                avgGrossScore={player?.total_gross ?? null}
                avgPar3={roundStats.avgPar3}
                avgPar4={roundStats.avgPar4}
                avgPar5={roundStats.avgPar5}
                birdiesOrBetter={roundStats.birdies}
                pars={roundStats.pars}
                bogeys={roundStats.bogeys}
                doublesPlus={roundStats.doubles}
              />
              <DirectionalMissCard
                sectionLabel="Driving"
                centerLabel="FIR"
                centerValue={roundStats.firPercent === null ? "—" : `${roundStats.firPercent.toFixed(0)}%`}
                miss={roundStats.firMiss}
                denominator={roundStats.firTotal}
                obValue={roundStats.firObPercent === null ? "—" : `${roundStats.firObPercent.toFixed(0)}%`}
              />
              <DirectionalMissCard
                sectionLabel="Approach"
                centerLabel="GIR"
                centerValue={roundStats.girPercent === null ? "—" : `${roundStats.girPercent.toFixed(0)}%`}
                miss={roundStats.girMiss}
                denominator={roundStats.girTotal}
                naValue={roundStats.girNaPercent === null ? "—" : `${roundStats.girNaPercent.toFixed(0)}%`}
                obValue={roundStats.girObPercent === null ? "—" : `${roundStats.girObPercent.toFixed(0)}%`}
                extraRows={roundStats.proximityRows}
                bands={roundGirBands}
              />
              <PuttingCard
                avgPuttsPerRound={roundStats.avgPuttsPerRound}
                puttDist={roundStats.puttDist}
                avgPuttMadeDistance={roundStats.avgPuttMadeDistance}
                longestPuttMade={roundStats.longestPuttMade}
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

  // GET /api/v1/me is shared with the Profile tab — React Query serves it from cache.
  // We need the DB UUID (me.id) to call the stats endpoint for handicap data.
  const { data: me } = useQuery<{ id: string }>({
    queryKey: ["me"],
    queryFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to fetch me: ${res.status}`);
      return res.json();
    },
  });

  // Handicap index and anti-handicap are hidden pending GHIN integration review.
  // Re-enable by restoring the useQuery call and <HandicapSection /> render below.
  // const { data: hcStats, isLoading: hcLoading } = useQuery<UserHandicapStats>({
  //   queryKey: ["userStats", me?.id],
  //   queryFn: async () => {
  //     const token = await getToken();
  //     const res = await apiFetch(`${API_URL}/api/v1/users/${me!.id}/stats`, {
  //       headers: { Authorization: `Bearer ${token}` },
  //     });
  //     if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`);
  //     return res.json();
  //   },
  //   enabled: !!me?.id,
  // });

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

  const stats        = useMemo(() => buildMyStats(scorecards, filteredRounds),       [scorecards, filteredRounds]);
  const girBands     = useMemo(() => buildGirByBand(scorecards),                     [scorecards]);
  const scoreHistory = useMemo(() => buildScoreHistory(scorecards, filteredRounds),  [scorecards, filteredRounds]);

  // Scoring summary for the Scores tab: avg, high, and low from the same
  // 18-hole-equivalent gross scores that buildMyStats computed (paired 9s included).
  const scoringSummary = useMemo(() => {
    const { grossScores } = stats;
    if (grossScores.length === 0) return null;
    const avg = grossScores.reduce((s, g) => s + g, 0) / grossScores.length;
    return { avg, low: Math.min(...grossScores), high: Math.max(...grossScores) };
  }, [stats]);

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

              {/* HandicapSection hidden pending GHIN integration review */}
              {/* <HandicapSection
                handicapIndex={hcStats?.handicap_index}
                antiHandicap={hcStats?.anti_handicap}
                loading={hcLoading}
              /> */}
              <ScoringCard
                avgGrossScore={stats.avgGrossScore}
                lowScore={stats.lowScore}
                highScore={stats.highScore}
                avgPar3={stats.avgPar3}
                avgPar4={stats.avgPar4}
                avgPar5={stats.avgPar5}
                birdiesOrBetter={stats.birdiesOrBetter}
                pars={stats.parsCount}
                bogeys={stats.bogeysCount}
                doublesPlus={stats.doublesPlus}
              />
              <DirectionalMissCard
                sectionLabel="Driving"
                centerLabel="FIR"
                centerValue={stats.firPercent === null ? "—" : `${stats.firPercent.toFixed(0)}%`}
                miss={stats.firMiss}
                denominator={stats.firTotal}
                obValue={stats.firObPercent === null ? "—" : `${stats.firObPercent.toFixed(0)}%`}
              />
              <DirectionalMissCard
                sectionLabel="Approach"
                centerLabel="GIR"
                centerValue={stats.girPercent === null ? "—" : `${stats.girPercent.toFixed(0)}%`}
                miss={stats.girMiss}
                denominator={stats.girTotal}
                naValue={stats.girNaPercent === null ? "—" : `${stats.girNaPercent.toFixed(0)}%`}
                obValue={stats.girObPercent === null ? "—" : `${stats.girObPercent.toFixed(0)}%`}
                extraRows={stats.proximityRows}
                bands={girBands}
              />
              <PuttingCard
                avgPuttsPerRound={stats.avgPuttsPerRound}
                puttDist={stats.puttDist}
                avgPuttMadeDistance={stats.avgPuttMadeDistance}
                longestPuttMade={stats.longestPuttMade}
              />
            </>
          ) : (
            <>
              <ScoreHistoryChart points={scoreHistory} />

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
                      18-Hole Avg
                    </Text>
                  </View>
                  <View className={`w-px ${t.border} border-l`} />
                  <View className="flex-1 items-center py-3">
                    <Text className="text-xl font-bold text-green-600">{scoringSummary.low}</Text>
                    <Text className={`text-xs font-semibold uppercase tracking-widest mt-0.5 ${t.textTertiary}`}>
                      18-Hole Low
                    </Text>
                  </View>
                  <View className={`w-px ${t.border} border-l`} />
                  <View className="flex-1 items-center py-3">
                    <Text className="text-xl font-bold text-red-500">{scoringSummary.high}</Text>
                    <Text className={`text-xs font-semibold uppercase tracking-widest mt-0.5 ${t.textTertiary}`}>
                      18-Hole High
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
