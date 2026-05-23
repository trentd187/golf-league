// app/(tabs)/friends.tsx
// Friends tab — shows the list of players the signed-in user is following
// and provides a shortcut to the player search screen.

import { useUser } from "@/hooks/useUser";
import { useAuth } from "@/hooks/useAuth";
import { apiFetch } from "@/utils/api";
import { API_URL } from "@/constants/api";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import UserAvatar from "@/components/UserAvatar";
import {
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";

export default function FriendsScreen() {
  const { user } = useUser();
  const { getToken } = useAuth();
  const router = useRouter();
  const t = useTheme();

  const { data: following, isLoading: followingLoading } = useQuery({
    queryKey: ["users", "following"],
    queryFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/users/following`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load following list");
      return res.json() as Promise<
        { id: string; display_name: string; avatar_url: string | null; rounds_played: number }[]
      >;
    },
    // Only fetch once the Supabase session is ready (user is truthy).
    enabled: !!user,
  });

  return (
    <ScrollView className={`flex-1 ${t.screen}`}>
      <View className="px-5 pt-14 pb-10">

        <Text className={`text-2xl font-bold mb-8 ${t.textPrimary}`}>Friends</Text>

        {/* ── Following ────────────────────────────────────────────────────── */}
        <Text className={`text-xs font-semibold uppercase tracking-widest mb-3 mt-2 ${t.textTertiary}`}>
          Following
        </Text>

        <View className={`${t.surface} rounded-2xl mb-4 border ${t.border} overflow-hidden`}>
          {followingLoading ? (
            <View className="py-6 items-center">
              <ActivityIndicator color={t.colors.tabBarActive} />
            </View>
          ) : !following || following.length === 0 ? (
            <View className="py-5 px-4 items-center">
              <Text className={`text-sm ${t.textTertiary}`}>
                You&apos;re not following anyone yet.
              </Text>
            </View>
          ) : (
            following.map((player, idx) => (
              <TouchableOpacity
                key={player.id}
                className={`flex-row items-center gap-3 px-4 py-3 ${
                  idx < following.length - 1 ? `border-b ${t.divider}` : ""
                }`}
                onPress={() => router.push(`/users/${player.id}`)}
                activeOpacity={0.7}
              >
                <UserAvatar
                  avatarUrl={player.avatar_url}
                  displayName={player.display_name}
                  size={38}
                />
                <View className="flex-1">
                  <Text className={`font-semibold text-sm ${t.textPrimary}`} numberOfLines={1}>
                    {player.display_name}
                  </Text>
                  <Text className={`text-xs ${t.textTertiary}`}>
                    {player.rounds_played} {player.rounds_played === 1 ? "round" : "rounds"} played
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={14} color={t.colors.tabBarInactive} />
              </TouchableOpacity>
            ))
          )}
        </View>

        {/* ── Find Players ─────────────────────────────────────────────────── */}
        <TouchableOpacity
          className={`flex-row items-center justify-between ${t.surface} rounded-2xl p-4 mb-4 border ${t.border}`}
          onPress={() => router.push("/users/search")}
          activeOpacity={0.7}
        >
          <View className="flex-row items-center gap-3">
            <Ionicons name="people-outline" size={20} color={t.colors.tabBarActive} />
            <Text className={`font-semibold ${t.textPrimary}`}>Find Players</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={t.colors.tabBarInactive} />
        </TouchableOpacity>

      </View>
    </ScrollView>
  );
}
