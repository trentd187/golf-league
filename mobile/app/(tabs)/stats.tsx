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
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
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

// FilterValue is "last20" | "all" | a 4-digit year string like "2026".
type FilterValue = "last20" | "all" | string;

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

// buildMyStats aggregates the caller's personal stats across a set of scorecards.
function buildMyStats(scorecards: Scorecard[]) {
  let rounds = 0;
  let totalBirdies = 0;
  let totalGross = 0;
  let grossCount = 0;
  let totalPutts = 0;
  let puttRounds = 0;
  let greensHit = 0;
  let greensTotal = 0;
  let fairwaysHit = 0;
  let fairwaysTotal = 0;

  for (const sc of scorecards) {
    const holeMap = new Map(sc.holes.map((h) => [h.hole_number, h.par]));
    const player = findMyPlayer(sc);
    if (!player) continue;

    rounds++;

    totalBirdies += player.scores.filter(
      (s) => (holeMap.get(s.hole_number) ?? -99) === s.gross_score + 1
    ).length;

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
  }

  return {
    rounds,
    totalBirdies,
    avgGrossScore:    grossCount > 0     ? totalGross / grossCount            : null,
    avgPuttsPerRound: puttRounds > 0    ? totalPutts / puttRounds            : null,
    girPercent:       greensTotal > 0   ? (greensHit / greensTotal) * 100    : null,
    firPercent:       fairwaysTotal > 0 ? (fairwaysHit / fairwaysTotal) * 100 : null,
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

// StatSection renders a placeholder card for one stat category.
// Used in both the aggregated Stats tab and the per-round RoundStatsModal.
function StatSection({ label }: { label: string }) {
  const t = useTheme();
  return (
    <View className={`${t.surface} rounded-2xl border ${t.border} p-4 mb-3`}>
      <Text className={`text-xs font-bold uppercase tracking-widest ${t.textTertiary} mb-3`}>
        {label}
      </Text>
      <Text className={`text-sm ${t.textSecondary}`}>Coming soon</Text>
    </View>
  );
}

// HoleTableRow renders a single hole inside the scorecard grid.
// runningDiff is the cumulative to-par total from hole 1 through this hole —
// undefined when the player hasn't scored this hole yet.
function HoleTableRow({
  hole,
  gross,
  runningDiff,
}: {
  hole: ScorecardHole;
  gross: number | undefined;
  runningDiff: number | undefined;
}) {
  const t = useTheme();
  const hasScore = gross !== undefined;
  const colorClass = hasScore ? scoreTextColor(gross, hole.par) : "";

  const runningText =
    runningDiff === undefined
      ? "—"
      : runningDiff === 0
      ? "E"
      : runningDiff > 0
      ? `+${runningDiff}`
      : `${runningDiff}`;

  const runningColor =
    runningDiff === undefined || runningDiff === 0
      ? t.textTertiary
      : runningDiff < 0
      ? "text-green-600"
      : "text-red-500";

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

// HoleTotalsRow renders the OUT / IN / TOT summary row inside the scorecard grid.
function HoleTotalsRow({
  label,
  par,
  gross,
}: {
  label: string;
  par: number;
  gross: number | null;
}) {
  const t = useTheme();
  const diff = gross !== null ? gross - par : null;
  const toParText =
    diff === null ? "—" : diff === 0 ? "E" : diff > 0 ? `+${diff}` : `${diff}`;
  const toParColor =
    diff === null || diff === 0
      ? t.textTertiary
      : diff < 0
      ? "text-green-600"
      : "text-red-500";

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

// RoundStatsModal shows the per-round stat sections (same structure as the Stats tab).
// The scorecard must be loaded before this modal is opened — the parent ensures this.
function RoundStatsModal({
  round,
  onClose,
}: {
  round: RoundSummary;
  onClose: () => void;
}) {
  const t = useTheme();

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

          {STAT_SECTIONS.map((section) => (
            <StatSection key={section} label={section} />
          ))}
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
}: {
  round: RoundSummary;
  scorecard: Scorecard;
  onClose: () => void;
}) {
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
}: {
  round: RoundSummary;
  scorecard: Scorecard | undefined;
  onStatsPress: () => void;
  onScorecardPress: () => void;
}) {
  const t = useTheme();

  const player = scorecard ? findMyPlayer(scorecard) : undefined;
  const scoreDisplay = player?.total_gross != null ? String(player.total_gross) : "—";

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
          className={`flex-1 flex-row items-center justify-center gap-1.5 py-2 rounded-xl border ${t.border} ${t.surface} ${!scorecardReady ? "opacity-40" : ""}`}
          onPress={onStatsPress}
          disabled={!scorecardReady}
          activeOpacity={0.75}
        >
          <Ionicons name="bar-chart-outline" size={14} color={t.colors.tabBarInactive} />
          <Text className={`text-sm font-semibold ${t.textSecondary}`}>Stats</Text>
        </TouchableOpacity>
        <TouchableOpacity
          className={`flex-1 flex-row items-center justify-center gap-1.5 py-2 rounded-xl border ${t.border} ${t.surface} ${!scorecardReady ? "opacity-40" : ""}`}
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

const STAT_SECTIONS = ["Scoring", "Driving", "Approach", "Putting", "Recovery"] as const;

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
      const res = await fetch(`${API_URL}/api/v1/rounds`, {
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
        const res = await fetch(`${API_URL}/api/v1/rounds/${round.id}/scorecard`, {
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

  return (
    <View className={`flex-1 ${t.screen}`}>
      {/* Per-round modals — rendered outside the ScrollView so they overlay the full screen */}
      {selectedRound && openModal === "stats" && (
        <RoundStatsModal round={selectedRound} onClose={closeModal} />
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
                {stats.rounds} round{stats.rounds !== 1 ? "s" : ""}
                {activeFilter === "last20" ? " · Last 20"
                  : activeFilter === "all"  ? " · All Time"
                  : ` · ${activeFilter}`}
              </Text>

              {/* Stat category sections — content TBD */}
              {STAT_SECTIONS.map((section) => (
                <StatSection key={section} label={section} />
              ))}
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
                {filteredRounds.length} round{filteredRounds.length !== 1 ? "s" : ""}
                {activeFilter === "last20" ? " · Last 20"
                  : activeFilter === "all"  ? " · All Time"
                  : ` · ${activeFilter}`}
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
