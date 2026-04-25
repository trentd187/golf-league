// app/users/search.tsx
// User search screen — search all registered players by name or email.
//
// Results include an is_following flag so the follow state is visible inline.
// Tapping a row navigates to the user's public profile (/users/[userId]).
// The follow/unfollow button on each row is a shortcut that skips the profile screen.
//
// Navigated to from:
//   - profile tab "Find Players" button

import { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import { apiFetch } from "@/utils/api";
import UserAvatar from "@/components/UserAvatar";

// ─── Types ────────────────────────────────────────────────────────────────────

type UserSearchResult = {
  id: string;
  display_name: string;
  email: string;
  avatar_url: string | null;
  is_following: boolean;
};

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function UserSearchScreen() {
  const router = useRouter();
  const { getToken } = useAuth();
  const t = useTheme();
  const queryClient = useQueryClient();

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // Debounce the query by 300ms so we don't fire on every keystroke.
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQuery(query), 300);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [query]);

  const {
    data: results,
    isLoading,
    isFetching,
  } = useQuery<UserSearchResult[]>({
    queryKey: ["users", "search", debouncedQuery],
    queryFn: async () => {
      const token = await getToken();
      const url = debouncedQuery
        ? `${API_URL}/api/v1/users?q=${encodeURIComponent(debouncedQuery)}`
        : `${API_URL}/api/v1/users`;
      const res = await apiFetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to search users: ${res.status}`);
      return res.json();
    },
    enabled: debouncedQuery.length >= 1,
    placeholderData: (prev) => prev, // keep previous results while typing
  });

  const followMutation = useMutation({
    mutationFn: async ({ userId, following }: { userId: string; following: boolean }) => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/users/${userId}/follow`, {
        method: following ? "DELETE" : "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`Failed to ${following ? "unfollow" : "follow"}: ${res.status}`);
      }
      return { userId, following };
    },
    onSuccess: ({ userId, following }) => {
      // Flip is_following in the cached search results for all current query keys.
      queryClient.setQueriesData<UserSearchResult[]>(
        { queryKey: ["users", "search"] },
        (prev) =>
          prev?.map((u) =>
            u.id === userId ? { ...u, is_following: !following } : u
          )
      );
      // Flip in the individual profile cache if it exists.
      queryClient.setQueryData(["user", userId], (prev: UserSearchResult | undefined) =>
        prev ? { ...prev, is_following: !following } : prev
      );
      queryClient.invalidateQueries({ queryKey: ["following"] });
    },
  });

  // Which user ID is currently pending a follow mutation (for per-row loading state).
  const pendingUserId = followMutation.isPending ? followMutation.variables?.userId : null;

  return (
    <View className={`flex-1 ${t.screen}`}>
      {/* Header */}
      <View className={`flex-row items-center gap-3 px-4 pt-12 pb-3 border-b ${t.border}`}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={t.colors.tabBarActive} />
        </TouchableOpacity>
        <Text className={`text-lg font-bold ${t.textPrimary}`}>Find Players</Text>
      </View>

      {/* Search input */}
      <View className={`px-4 py-3 border-b ${t.border}`}>
        <View className={`flex-row items-center gap-2 ${t.surfaceSunken} rounded-xl px-3 py-2.5 border ${t.borderInput}`}>
          <Ionicons name="search-outline" size={18} color={t.colors.tabBarInactive} />
          <TextInput
            className={`flex-1 text-sm ${t.textPrimary}`}
            placeholder="Search by name or email…"
            placeholderTextColor={t.colors.tabBarInactive}
            value={query}
            onChangeText={setQuery}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery("")} hitSlop={6}>
              <Ionicons name="close-circle" size={18} color={t.colors.tabBarInactive} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Results / states */}
      {debouncedQuery.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-3 px-8">
          <Ionicons name="people-outline" size={48} color={t.colors.tabBarInactive} />
          <Text className={`text-base text-center ${t.textTertiary}`}>
            Start typing to search for players by name or email.
          </Text>
        </View>
      ) : isLoading && !results ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={t.colors.tabBarActive} />
        </View>
      ) : results && results.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-2 px-8">
          <Ionicons name="search-outline" size={40} color={t.colors.tabBarInactive} />
          <Text className={`text-base text-center ${t.textTertiary}`}>
            No players found for "{debouncedQuery}".
          </Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          // Subtle loading indicator in top-right while a new page of results loads.
          ListHeaderComponent={isFetching && results ? (
            <View className="items-end px-4 py-1">
              <ActivityIndicator size="small" color={t.colors.tabBarInactive} />
            </View>
          ) : null}
          renderItem={({ item }) => (
            <TouchableOpacity
              className={`flex-row items-center gap-3 px-4 py-3 border-b ${t.divider}`}
              activeOpacity={0.7}
              onPress={() => router.push(`/users/${item.id}`)}
            >
              <UserAvatar avatarUrl={item.avatar_url} displayName={item.display_name} size={40} />
              <View className="flex-1 min-w-0">
                <Text className={`text-sm font-semibold ${t.textPrimary}`} numberOfLines={1}>
                  {item.display_name}
                </Text>
                <Text className={`text-xs ${t.textTertiary}`} numberOfLines={1}>
                  {item.email}
                </Text>
              </View>
              {/* Follow / Unfollow button */}
              <TouchableOpacity
                className={`px-3 py-1.5 rounded-lg border ${
                  item.is_following ? t.border : "border-green-700"
                }`}
                activeOpacity={0.7}
                disabled={pendingUserId === item.id}
                onPress={(e) => {
                  e.stopPropagation();
                  followMutation.mutate({ userId: item.id, following: item.is_following });
                }}
              >
                {pendingUserId === item.id ? (
                  <ActivityIndicator size="small" color={t.colors.tabBarActive} />
                ) : (
                  <Text
                    className={`text-xs font-semibold ${
                      item.is_following ? t.textSecondary : "text-green-700"
                    }`}
                  >
                    {item.is_following ? "Following" : "Follow"}
                  </Text>
                )}
              </TouchableOpacity>
            </TouchableOpacity>
          )}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 40 }}
        />
      )}
    </View>
  );
}
