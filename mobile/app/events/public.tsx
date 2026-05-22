// app/events/public.tsx
// Public Events discover screen — lists events with is_public=true that the
// current user is not already a member of. Each card has a "Request to Join"
// button that submits a join request (pending organizer approval).
//
// After requesting to join, the event is removed from this list on next fetch
// because the user now has an event_players row (GET /events/public excludes
// events the caller is any kind of member of, including pending).

import { useState, useCallback } from "react";
import {
  Text,
  View,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";

import { useRouter, useFocusEffect } from "expo-router";
import { useAuth } from "@/hooks/useAuth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Ionicons from "@expo/vector-icons/Ionicons";
import { API_URL } from "@/constants/api";
import { apiFetch } from "@/utils/api";
import { useTheme } from "@/hooks/useTheme";
import { EventTypeBadge } from "@/components/badges";
import { apiToDisplay } from "@/components/DateInput";
import { showAlert, showConfirm } from "@/utils/alerts";

// ─── Types ────────────────────────────────────────────────────────────────────

type PublicEvent = {
  id: string;
  name: string;
  description: string | null;
  event_type: "league" | "tournament" | "casual";
  status: string;
  start_date: string | null;
  end_date: string | null;
  creator_name: string;
  member_count: number;
  created_at: string;
};

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function PublicEventsScreen() {
  const router = useRouter();
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const t = useTheme();

  // Track which events have a pending request in this session so the button
  // updates immediately without waiting for a refetch.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const {
    data: events,
    isLoading,
    isError,
    refetch,
  } = useQuery<PublicEvent[]>({
    queryKey: ["events", "public"],
    queryFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/events/public`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to fetch public events: ${res.status}`);
      return res.json();
    },
  });

  // Refetch whenever this screen comes back into focus (e.g. after navigating away).
  useFocusEffect(
    useCallback(() => {
      const state = queryClient.getQueryState(["events", "public"]);
      if (state?.isInvalidated) {
        refetch();
      }
    }, [queryClient, refetch])
  );

  const requestJoinMutation = useMutation({
    mutationFn: async (eventId: string) => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/events/${eventId}/request-join`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }
      return eventId;
    },
    onSuccess: (eventId) => {
      setPendingIds((prev) => new Set([...prev, eventId]));
      queryClient.invalidateQueries({ queryKey: ["events", "public"] });
      queryClient.invalidateQueries({ queryKey: ["events"] });
    },
    onError: (err: Error) => {
      showAlert("Could not request to join", err.message);
    },
  });

  const handleRequestJoin = (event: PublicEvent) => {
    showConfirm(
      `Request to join "${event.name}"?`,
      "An organizer will review your request before you're added.",
      () => requestJoinMutation.mutate(event.id),
      "Request",
      "Cancel",
    );
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <View className={`flex-1 ${t.screen}`}>
      <View className="pt-14 flex-1">

        {/* Header */}
        <View className="px-5 flex-row items-center gap-3 mb-6">
          <TouchableOpacity
            onPress={() => router.back()}
            accessibilityLabel="Go back"
            className="p-1 -ml-1"
          >
            <Ionicons name="arrow-back" size={22} color={t.colors.tabBarInactive} />
          </TouchableOpacity>
          <View className="flex-1">
            <Text className={`text-2xl font-bold ${t.textPrimary}`}>Discover Events</Text>
            <Text className={`text-xs ${t.textTertiary} mt-0.5`}>
              Public events open for anyone to join
            </Text>
          </View>
        </View>

        {isLoading ? (
          <ActivityIndicator className="mt-8" color={t.colors.tabBarActive} />
        ) : isError ? (
          <View className="flex-1 items-center justify-center px-8">
            <Text className={`text-base text-center ${t.textSecondary}`}>
              Could not load public events. Pull to refresh.
            </Text>
            <TouchableOpacity
              className={`mt-4 ${t.primaryBg} rounded-xl px-5 py-3`}
              onPress={() => refetch()}
            >
              <Text className="text-white font-semibold text-sm">Retry</Text>
            </TouchableOpacity>
          </View>
        ) : !events || events.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <Ionicons name="globe-outline" size={48} color={t.colors.tabBarInactive} />
            <Text className={`text-base font-semibold mt-3 mb-1 ${t.textPrimary}`}>
              No public events yet
            </Text>
            <Text className={`text-sm text-center ${t.textSecondary}`}>
              Public events created by other players will appear here.
            </Text>
          </View>
        ) : (
          <FlatList
            data={events}
            keyExtractor={(e) => e.id}
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32 }}
            renderItem={({ item }) => {
              const isPending = pendingIds.has(item.id);
              const isMutating = requestJoinMutation.isPending && requestJoinMutation.variables === item.id;
              return (
                <View className={`${t.surface} rounded-2xl p-4 mb-3 border ${t.border}`}>
                  {/* Name + type */}
                  <View className="flex-row items-center justify-between mb-1">
                    <Text
                      className={`font-semibold text-base flex-1 mr-2 ${t.textPrimary}`}
                      numberOfLines={1}
                    >
                      {item.name}
                    </Text>
                    <EventTypeBadge type={item.event_type} />
                  </View>

                  {item.description ? (
                    <Text className={`text-sm mb-2 ${t.textSecondary}`} numberOfLines={2}>
                      {item.description}
                    </Text>
                  ) : null}

                  {(item.start_date || item.end_date) && (
                    <View className="flex-row items-center gap-1 mb-2">
                      <Ionicons name="calendar-outline" size={12} color={t.colors.tabBarInactive} />
                      <Text className={`text-xs ${t.textTertiary}`}>
                        {item.start_date ? apiToDisplay(item.start_date) : "—"}
                        {item.end_date ? ` → ${apiToDisplay(item.end_date)}` : ""}
                      </Text>
                    </View>
                  )}

                  <View className="flex-row items-center justify-between mt-2">
                    <View>
                      <Text className={`text-xs ${t.textTertiary}`}>
                        {item.creator_name} · {item.member_count} {item.member_count === 1 ? "member" : "members"}
                      </Text>
                    </View>

                    {isPending ? (
                      <View className="flex-row items-center gap-1 px-3 py-1.5 rounded-xl bg-amber-50 border border-amber-200">
                        <Ionicons name="time-outline" size={13} color="#d97706" />
                        <Text className="text-xs font-semibold text-amber-700">Pending</Text>
                      </View>
                    ) : (
                      <TouchableOpacity
                        className={`flex-row items-center gap-1.5 px-3 py-1.5 rounded-xl ${
                          isMutating ? "bg-green-100" : "bg-green-700"
                        }`}
                        onPress={() => handleRequestJoin(item)}
                        disabled={isMutating}
                        activeOpacity={0.8}
                      >
                        {isMutating ? (
                          <ActivityIndicator size="small" color="#15803d" />
                        ) : (
                          <>
                            <Ionicons name="person-add-outline" size={13} color="white" />
                            <Text className="text-xs font-semibold text-white">Request to Join</Text>
                          </>
                        )}
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              );
            }}
          />
        )}
      </View>
    </View>
  );
}
