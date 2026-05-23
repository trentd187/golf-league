// app/(tabs)/rounds.tsx
// The Rounds tab — shows all rounds the authenticated user is a member of.
// Covers both event-linked rounds and eventless (casual) rounds created via
// the "+" button in the header, which navigates to /rounds/create.
//
// Rounds are split into three visual sections:
//   1. Active — rounds currently in progress (status = "active")
//   2. Upcoming — scheduled rounds (status = "scheduled")
//   3. Completed — finished rounds (status = "completed")
//
// All three are returned by GET /api/v1/rounds, ordered by scheduled_date DESC.
// Tapping a card navigates to /rounds/:id (the Round detail screen).
//
// useFocusEffect refetches when the tab becomes active so the list stays current
// after returning from the round detail or scorecard screens.

import { useCallback, useState } from "react";
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
import { formatLabel } from "@/utils/scoringFormats";

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

// ─── Section header ───────────────────────────────────────────────────────────

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

  // Refetch when the tab gains focus — picks up changes made on other screens
  // without refetching on every render.
  useFocusEffect(
    useCallback(() => {
      if (queryClient.getQueryState(["my-rounds"])?.isInvalidated) {
        refetch();
      }
    }, [queryClient, refetch])
  );

  // ─── Loading / error ──────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <View className={`flex-1 ${t.screen} items-center justify-center`}>
        <ActivityIndicator size="large" color={t.colors.tabBarActive} />
      </View>
    );
  }

  if (isError || !rounds) {
    return (
      <View className={`flex-1 ${t.screen} items-center justify-center gap-3 px-8`}>
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
    );
  }

  // ─── Partition by status ───────────────────────────────────────────────────

  const active    = rounds.filter((r) => r.status === "active");
  const scheduled = rounds.filter((r) => r.status === "scheduled");
  const completed = rounds.filter((r) => r.status === "completed");

  // ─── Empty state ──────────────────────────────────────────────────────────

  if (rounds.length === 0) {
    return (
      <View className={`flex-1 ${t.screen}`}>
        {/* Header row with title + create button, mirrored from the list view */}
        <View className="flex-row items-center justify-between px-5 pt-16 pb-2">
          <Text className={`text-2xl font-bold ${t.textPrimary}`}>My Rounds</Text>
          <TouchableOpacity
            onPress={() => router.push("/rounds/create")}
            activeOpacity={0.7}
          >
            <Ionicons name="add-circle-outline" size={28} color={t.colors.tabBarActive} />
          </TouchableOpacity>
        </View>
        <View className="flex-1 items-center justify-center gap-4 px-8">
          <Ionicons name="flag-outline" size={64} color={t.colors.tabBarActive} />
          <Text className={`text-xl font-bold ${t.textPrimary}`}>No Rounds Yet</Text>
          <Text className={`text-base text-center ${t.textSecondary}`}>
            Tap the <Text className="font-semibold">+</Text> button above to start a casual round, or join an event to play in a league or tournament.
          </Text>
        </View>
      </View>
    );
  }

  // ─── Flat list data with section headers ──────────────────────────────────

  // Build a flat data array interleaving label items and round items.
  // FlatList is used for efficient rendering; section labels are inline items.
  type ListItem =
    | { kind: "label"; label: string; key: string }
    | { kind: "round"; round: MyRound };

  const items: ListItem[] = [];

  if (active.length > 0) {
    items.push({ kind: "label", label: "Active", key: "label-active" });
    active.forEach((r) => items.push({ kind: "round", round: r }));
  }
  if (scheduled.length > 0) {
    items.push({ kind: "label", label: "Upcoming", key: "label-scheduled" });
    scheduled.forEach((r) => items.push({ kind: "round", round: r }));
  }
  if (completed.length > 0) {
    items.push({ kind: "label", label: "Completed", key: "label-completed" });
    completed.forEach((r) => items.push({ kind: "round", round: r }));
  }

  return (
    <View className={`flex-1 ${t.screen}`}>
      <FlatList
        data={items}
        keyExtractor={(item) =>
          item.kind === "label" ? item.key : item.round.id
        }
        contentContainerStyle={{ padding: 20, paddingTop: 60 }}
        ListHeaderComponent={
          <View className="flex-row items-center justify-between mb-1">
            <Text className={`text-2xl font-bold ${t.textPrimary}`}>My Rounds</Text>
            <TouchableOpacity
              onPress={() => router.push("/rounds/create")}
              activeOpacity={0.7}
            >
              <Ionicons name="add-circle-outline" size={28} color={t.colors.tabBarActive} />
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item }) => {
          if (item.kind === "label") {
            return <SectionLabel label={item.label} />;
          }
          return (
            <RoundCard
              round={item.round}
              onPress={() => router.push(`/rounds/${item.round.id}`)}
            />
          );
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            colors={[t.colors.tabBarActive]}
            tintColor={t.colors.tabBarActive}
          />
        }
      />
    </View>
  );
}
