// app/(tabs)/stats.tsx
// Stats screen — personal scoring stats for the logged-in user.
//
// Two inner tabs (Stats | Scores) share a top-level period filter:
//   Stats  — aggregated stat sections (Scoring, Driving, Approach, Putting, Recovery)
//   Scores — scoring history line chart + per-round score list with scorecard links
//
// Data flow:
//   1. GET /api/v1/rounds fetches all rounds the user is in (cached with the Rounds tab)
//   2. Completed rounds are filtered to the active period
//   3. Scorecards for those rounds are fetched in parallel via useQueries
//   4. buildMyStats uses scorecard.caller_user_id (the DB UUID returned by the API)
//      to find the caller's player entry and aggregate their numbers

import { useState, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "@clerk/clerk-expo";
import { useQuery, useQueries } from "@tanstack/react-query";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import type { Scorecard, ScorecardPlayer } from "@/types/scorecard";

// ─── Types ────────────────────────────────────────────────────────────────────

// Minimal shape from GET /api/v1/rounds — only the fields we need here.
type RoundSummary = {
  id: string;
  scheduled_date: string; // "YYYY-MM-DD"
  status: string;
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

// ─── Sub-components ───────────────────────────────────────────────────────────

// StatSection renders a placeholder card for one stat category.
// The stats within each section will be populated in a future iteration.
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

// ScoreRow renders one round's gross score in the Scores tab list.
// Tapping navigates to the full scorecard screen.
function ScoreRow({
  round,
  scorecard,
  onPress,
}: {
  round: RoundSummary;
  scorecard: Scorecard | undefined;
  onPress: () => void;
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

  return (
    <TouchableOpacity
      className={`flex-row items-center justify-between ${t.surface} rounded-2xl border ${t.border} p-4 mb-3`}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <View className="flex-1 gap-0.5">
        <Text className={`text-sm font-semibold ${t.textPrimary}`}>
          {scorecard?.round_name ?? "Round"}
        </Text>
        <Text className={`text-xs ${t.textTertiary}`}>{date}</Text>
      </View>
      <View className="flex-row items-center gap-2">
        <Text className={`text-xl font-bold ${t.textPrimary}`}>{scoreDisplay}</Text>
        <Ionicons name="chevron-forward" size={16} color={t.colors.tabBarInactive} />
      </View>
    </TouchableOpacity>
  );
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STAT_SECTIONS = ["Scoring", "Driving", "Approach", "Putting", "Recovery"] as const;

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function StatsScreen() {
  const { getToken } = useAuth();
  const router = useRouter();
  const t = useTheme();

  const [activeFilter, setActiveFilter] = useState<FilterValue>("last20");
  const [innerTab, setInnerTab] = useState<InnerTab>("stats");

  // GET /api/v1/rounds is shared with the Rounds tab — React Query serves it from cache.
  const { data: allRounds, isLoading: roundsLoading, isError: roundsError } = useQuery<RoundSummary[]>({
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
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
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
              {filteredRounds.map((round) => (
                <ScoreRow
                  key={round.id}
                  round={round}
                  scorecard={scorecards.find((sc) => sc.round_id === round.id)}
                  onPress={() => router.push(`/rounds/${round.id}`)}
                />
              ))}
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
