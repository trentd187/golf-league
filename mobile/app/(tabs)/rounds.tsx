// app/(tabs)/rounds.tsx
// The Rounds tab — shows all rounds the authenticated user is a member of.
// Covers both event-linked rounds and eventless (casual) rounds created via
// the "+" button in the header, which navigates to /rounds/create.
//
// Rounds are grouped into three visual sections by status:
//   1. Active — rounds currently in progress (status = "active")
//   2. Upcoming — scheduled rounds (status = "scheduled")
//   3. Completed — finished rounds (status = "completed")
//
// A Filter + Sort bar (shared with the Events screen — FilterSortBar /
// FilterSheet / SortSheet) narrows and reorders the list: Filter by status and
// scoring format, Sort by date / name / course. The selection is persisted
// across sessions in the shared list-prefs store. Filtering hides non-matching
// cards (and empty sections); sorting reorders cards within each section.
//
// All rounds come from GET /api/v1/rounds. Tapping a card navigates to
// /rounds/:id. useFocusEffect refetches when the query was invalidated so the
// list stays current after returning from the round detail or scorecard screens.

import { useCallback, useMemo, useState } from "react";
import {
  Text,
  View,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from "react-native";

import { useAuth } from "@/hooks/useAuth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter, useFocusEffect } from "expo-router";
import { API_URL } from "@/constants/api";
import { apiFetch } from "@/utils/api";
import { useTheme } from "@/hooks/useTheme";
import { RoundStatusChip } from "@/components/badges";
import { apiToDisplay } from "@/components/DateInput";
import { formatLabel, SCORING_FORMATS } from "@/utils/scoringFormats";
import FilterSortBar from "@/components/FilterSortBar";
import FilterSheet from "@/components/FilterSheet";
import SortSheet from "@/components/SortSheet";
import { useListPrefsStore } from "@/stores/listPrefsStore";
import {
  filterRounds,
  sortRounds,
  type RoundStatusFilter,
  type RoundSortKey,
} from "@/utils/roundFilters";

// ─── Types ────────────────────────────────────────────────────────────────────

type MyRound = {
  id: string;
  name: string;
  event_id: string | null;   // null for eventless (casual) rounds
  event_name: string | null; // null for eventless (casual) rounds
  course_name: string;
  scheduled_date: string; // "YYYY-MM-DD"
  status: string;         // "scheduled" | "active" | "completed"
  scoring_format: string;
  round_number: number;
  group_count: number;
};

// FlatList rows interleave section labels and round cards in one flat array.
type ListItem =
  | { kind: "label"; label: string; key: string }
  | { kind: "round"; round: MyRound };

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_FILTER_OPTIONS: { value: RoundStatusFilter; label: string }[] = [
  { value: "all",       label: "All Status" },
  { value: "active",    label: "Active" },
  { value: "scheduled", label: "Upcoming" },
  { value: "completed", label: "Completed" },
];

// "All Formats" plus every scoring format from the shared source of truth, so
// new formats appear here automatically.
const FORMAT_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All Formats" },
  ...SCORING_FORMATS,
];

// shortLabel is shown on the sort button; label is shown inside the sort sheet.
const SORT_OPTIONS: { value: RoundSortKey; label: string; shortLabel: string }[] = [
  { value: "date_desc",  label: "Date (latest first)",   shortLabel: "Date ↓" },
  { value: "date_asc",   label: "Date (earliest first)", shortLabel: "Date ↑" },
  { value: "name_asc",   label: "Name (A–Z)",            shortLabel: "A–Z" },
  { value: "course_asc", label: "Course (A–Z)",          shortLabel: "Course" },
];

// Fixed section order — sort reorders cards within each, never across sections.
const SECTIONS: { label: string; status: string }[] = [
  { label: "Active",    status: "active" },
  { label: "Upcoming",  status: "scheduled" },
  { label: "Completed", status: "completed" },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function RoundCard({ round, onPress }: { round: MyRound; onPress: () => void }) {
  const t = useTheme();

  return (
    <TouchableOpacity
      className={`${t.surface} rounded-2xl p-4 mb-3 border ${t.border}`}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <View className="flex-row items-start justify-between mb-1 gap-2">
        <Text className={`font-semibold text-base flex-1 ${t.textPrimary}`} numberOfLines={1}>
          {round.name}
        </Text>
        <RoundStatusChip status={round.status} />
      </View>

      {/* Event name — only shown for event-linked rounds */}
      {round.event_name && (
        <Text className={`text-xs mb-2 ${t.textTertiary}`} numberOfLines={1}>
          {round.event_name}
        </Text>
      )}

      <View className="flex-row items-center gap-1 mb-1">
        <Ionicons name="golf-outline" size={13} color={t.colors.tabBarInactive} />
        <Text className={`text-sm flex-1 ${t.textSecondary}`} numberOfLines={1}>
          {round.course_name}
        </Text>
      </View>

      <View className="flex-row items-center justify-between mt-1">
        <View className="flex-row items-center gap-1">
          <Ionicons name="calendar-outline" size={13} color={t.colors.tabBarInactive} />
          <Text className={`text-sm ${t.textSecondary}`}>
            {apiToDisplay(round.scheduled_date)}
          </Text>
        </View>
        <Text className={`text-xs ${t.textTertiary}`}>
          {formatLabel(round.scoring_format)}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

function SectionLabel({ label }: { label: string }) {
  const t = useTheme();
  return (
    <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 mt-4 ${t.textTertiary}`}>
      {label}
    </Text>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function RoundsScreen() {
  const t = useTheme();
  const router = useRouter();
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  // Filter / sort selection is persisted across sessions in the shared list-prefs
  // store (defaults: all statuses, all formats, newest scheduled first).
  const { statusFilter, formatFilter, sortKey } = useListPrefsStore((s) => s.rounds);
  const setRoundPrefs = useListPrefsStore((s) => s.setRoundPrefs);
  const resetRoundFilters = useListPrefsStore((s) => s.resetRoundFilters);
  const [filterModalVisible, setFilterModalVisible] = useState(false);
  const [sortModalVisible,   setSortModalVisible]   = useState(false);

  const {
    data: rounds,
    isLoading,
    isError,
    refetch,
  } = useQuery<MyRound[]>({
    queryKey: ["my-rounds"],
    queryFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/rounds`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to fetch rounds: ${res.status}`);
      return res.json();
    },
  });

  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  // Refetch when the tab gains focus only if the query was invalidated — picks up
  // changes made on other screens without refetching on every render.
  useFocusEffect(
    useCallback(() => {
      if (queryClient.getQueryState(["my-rounds"])?.isInvalidated) {
        refetch();
      }
    }, [queryClient, refetch])
  );

  // Filter, then partition into the fixed status sections, sorting each section.
  // Logic lives in utils/roundFilters.ts (pure + unit-tested) for coverage.
  const items = useMemo<ListItem[]>(() => {
    if (!rounds) return [];
    const filtered = filterRounds(rounds, statusFilter, formatFilter);
    const result: ListItem[] = [];
    for (const section of SECTIONS) {
      const inSection = sortRounds(
        filtered.filter((r) => r.status === section.status),
        sortKey,
      );
      if (inSection.length > 0) {
        result.push({ kind: "label", label: section.label, key: `label-${section.status}` });
        inSection.forEach((r) => result.push({ kind: "round", round: r }));
      }
    }
    return result;
  }, [rounds, statusFilter, formatFilter, sortKey]);

  // Sort default doesn't count as "active" — only the filter axes do (mirrors Events).
  const hasActiveFilters = statusFilter !== "all" || formatFilter !== "all";
  const hasRounds = (rounds?.length ?? 0) > 0;
  const currentSortShortLabel =
    SORT_OPTIONS.find((o) => o.value === sortKey)?.shortLabel ?? "Sort";

  // --- Render ---
  return (
    <View className={`flex-1 ${t.screen}`}>
      <View className="pt-14 flex-1">

        {/* Page header */}
        <View className="px-5 flex-row items-center justify-between mb-3">
          <Text className={`text-2xl font-bold ${t.textPrimary}`}>My Rounds</Text>
          <TouchableOpacity
            className={`${t.primaryBg} rounded-xl px-4 py-2 flex-row items-center gap-2`}
            onPress={() => router.push("/rounds/create")}
            activeOpacity={0.7}
          >
            <Ionicons name="add" size={18} color="white" />
            <Text className="text-white font-semibold text-sm">Create</Text>
          </TouchableOpacity>
        </View>

        {/* Filter + Sort bar — shared with the Events screen */}
        <FilterSortBar
          hasActiveFilters={hasActiveFilters}
          sortLabel={currentSortShortLabel}
          onOpenFilter={() => setFilterModalVisible(true)}
          onOpenSort={() => setSortModalVisible(true)}
        />

        {/* Content: loading / error / list / empty */}
        {isLoading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" color={t.colors.tabBarActive} />
          </View>
        ) : isError || !rounds ? (
          <View className="flex-1 items-center justify-center gap-3 px-8">
            <Ionicons name="alert-circle-outline" size={48} color="#dc2626" />
            <Text className={`font-semibold text-center ${t.textPrimary}`}>
              Failed to load rounds
            </Text>
            <TouchableOpacity
              className={`${t.primaryBg} rounded-xl px-6 py-3`}
              onPress={() => refetch()}
            >
              <Text className="text-white font-semibold">Retry</Text>
            </TouchableOpacity>
          </View>
        ) : items.length > 0 ? (
          <FlatList
            data={items}
            keyExtractor={(item) => (item.kind === "label" ? item.key : item.round.id)}
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}
            showsVerticalScrollIndicator={false}
            renderItem={({ item }) =>
              item.kind === "label" ? (
                <SectionLabel label={item.label} />
              ) : (
                <RoundCard
                  round={item.round}
                  onPress={() => router.push(`/rounds/${item.round.id}`)}
                />
              )
            }
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={handleRefresh}
                colors={[t.colors.tabBarActive]}
                tintColor={t.colors.tabBarActive}
              />
            }
          />
        ) : (
          <View className="flex-1 items-center justify-center gap-4 px-8">
            <Ionicons name="flag-outline" size={64} color={t.colors.tabBarActive} />
            {hasActiveFilters && hasRounds ? (
              <>
                <Text className={`text-xl font-bold ${t.textPrimary}`}>No matching rounds</Text>
                <Text className={`text-base text-center ${t.textSecondary}`}>
                  No rounds match the selected filters.
                </Text>
                <TouchableOpacity
                  className={`${t.primaryBg} rounded-xl px-6 py-3`}
                  onPress={resetRoundFilters}
                >
                  <Text className="text-white font-semibold">Clear Filters</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text className={`text-xl font-bold ${t.textPrimary}`}>No Rounds Yet</Text>
                <Text className={`text-base text-center ${t.textSecondary}`}>
                  Tap <Text className="font-semibold">+ Create</Text> above to start a casual round, or join an event to play in a league or tournament.
                </Text>
              </>
            )}
          </View>
        )}
      </View>

      {/* ── Filter + Sort sheets (shared with the Events screen) ──────────────── */}
      <FilterSheet
        visible={filterModalVisible}
        onClose={() => setFilterModalVisible(false)}
        showClearIcon={hasActiveFilters}
        onClearAll={resetRoundFilters}
        sections={[
          {
            key: "status",
            title: "Status",
            options: STATUS_FILTER_OPTIONS,
            selected: statusFilter,
            onSelect: (value) => setRoundPrefs({ statusFilter: value as RoundStatusFilter }),
          },
          {
            key: "format",
            title: "Scoring Format",
            options: FORMAT_FILTER_OPTIONS,
            selected: formatFilter,
            onSelect: (value) => setRoundPrefs({ formatFilter: value }),
          },
        ]}
      />

      <SortSheet
        visible={sortModalVisible}
        onClose={() => setSortModalVisible(false)}
        options={SORT_OPTIONS}
        selected={sortKey}
        onSelect={(value) => {
          setRoundPrefs({ sortKey: value as RoundSortKey });
          setSortModalVisible(false);
        }}
      />
    </View>
  );
}
