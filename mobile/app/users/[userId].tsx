// app/users/[userId].tsx
// Public profile screen for any registered user.
//
// Shows:
//   - Avatar, display name, rounds/events played counts
//   - Follow / Unfollow button (hidden for the caller's own profile via is_me)
//   - Career stats: avg gross, low/high round, par-type breakdown, FIR/GIR/putts
//
// Navigated to from:
//   - profile tab "Find Players" → search screen → tap row
//   - event detail members list → tap member row
//   - round detail group player list → tap player row

import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import { apiFetch } from "@/utils/api";
import UserAvatar from "@/components/UserAvatar";

// ─── Types ────────────────────────────────────────────────────────────────────

type UserProfile = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  rounds_played: number;
  events_played: number;
  is_following: boolean;
  is_me: boolean;
};

type UserStats = {
  avg_gross_per_round: number | null;
  low_round: number | null;
  high_round: number | null;
  eagles: number;
  birdies: number;
  pars: number;
  bogeys: number;
  double_plus: number;
  fir_pct: number | null;
  gir_pct: number | null;
  avg_putts_per_round: number | null;
  rounds_counted: number;
  filter: string;
};

// ─── Sub-components ───────────────────────────────────────────────────────────

// StatRow renders a single label + value pair inside a stat card.
function StatRow({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <View className={`flex-row items-center justify-between py-2.5 border-b ${t.divider}`}>
      <Text className={`text-sm ${t.textSecondary}`}>{label}</Text>
      <Text className={`text-sm font-semibold ${t.textPrimary}`}>{value}</Text>
    </View>
  );
}

// StatCard renders a labeled group of stat rows.
function StatCard({ label, rows }: { label: string; rows: { label: string; value: string }[] }) {
  const t = useTheme();
  return (
    <View className={`${t.surface} rounded-2xl border ${t.border} p-4 mb-3`}>
      <Text className={`text-sm font-bold uppercase tracking-widest ${t.textTertiary} mb-1`}>
        {label}
      </Text>
      {rows.map((row) => (
        <StatRow key={row.label} label={row.label} value={row.value} />
      ))}
    </View>
  );
}

// fmt formats a nullable number to a fixed-decimal string, showing "—" when null.
function fmt(value: number | null | undefined, decimals = 1): string {
  if (value == null) return "—";
  return value.toFixed(decimals);
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function UserProfileScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const router = useRouter();
  const { getToken } = useAuth();
  const t = useTheme();
  const queryClient = useQueryClient();

  const {
    data: profile,
    isLoading: profileLoading,
    isError: profileError,
  } = useQuery<UserProfile>({
    queryKey: ["user", userId],
    queryFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/users/${userId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to fetch profile: ${res.status}`);
      return res.json();
    },
    enabled: !!userId,
  });

  const { data: stats, isLoading: statsLoading } = useQuery<UserStats>({
    queryKey: ["user", userId, "stats"],
    queryFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/users/${userId}/stats`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`);
      return res.json();
    },
    enabled: !!userId && !!profile,
  });

  const followMutation = useMutation({
    mutationFn: async ({ following }: { following: boolean }) => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/users/${userId}/follow`, {
        method: following ? "DELETE" : "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`Failed to ${following ? "unfollow" : "follow"}: ${res.status}`);
      }
    },
    onSuccess: (_, { following }) => {
      // Flip the is_following field in the cached profile.
      queryClient.setQueryData<UserProfile>(["user", userId], (prev) =>
        prev ? { ...prev, is_following: !following } : prev
      );
      // Invalidate the following list so it stays in sync.
      queryClient.invalidateQueries({ queryKey: ["following"] });
    },
  });

  if (profileLoading) {
    return (
      <View className={`flex-1 items-center justify-center ${t.screen}`}>
        <ActivityIndicator color={t.colors.tabBarActive} />
      </View>
    );
  }

  if (profileError || !profile) {
    return (
      <View className={`flex-1 items-center justify-center ${t.screen} p-6`}>
        <Ionicons name="alert-circle-outline" size={40} color={t.colors.tabBarInactive} />
        <Text className={`text-base mt-3 ${t.textSecondary}`}>Could not load profile.</Text>
        <TouchableOpacity onPress={() => router.back()} className="mt-4">
          <Text className="text-green-700 font-semibold">Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isFollowing = profile.is_following;

  return (
    <View className={`flex-1 ${t.screen}`}>
      {/* Header */}
      <View className={`flex-row items-center gap-3 px-4 pt-12 pb-4 border-b ${t.border}`}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={t.colors.tabBarActive} />
        </TouchableOpacity>
        <Text className={`text-lg font-bold flex-1 ${t.textPrimary}`} numberOfLines={1}>
          {profile.display_name}
        </Text>
      </View>

      <ScrollView className="flex-1 px-4 pt-4">
        {/* Profile card */}
        <View className={`${t.surface} rounded-2xl border ${t.border} p-4 mb-4`}>
          <View className="flex-row items-center gap-4">
            <UserAvatar avatarUrl={profile.avatar_url} displayName={profile.display_name} size={64} />
            <View className="flex-1">
              <Text className={`text-xl font-bold ${t.textPrimary}`} numberOfLines={1}>
                {profile.display_name}
              </Text>
              <View className="flex-row gap-4 mt-1">
                <Text className={`text-sm ${t.textSecondary}`}>
                  <Text className={`font-semibold ${t.textPrimary}`}>{profile.rounds_played}</Text>
                  {" rounds"}
                </Text>
                <Text className={`text-sm ${t.textSecondary}`}>
                  <Text className={`font-semibold ${t.textPrimary}`}>{profile.events_played}</Text>
                  {" events"}
                </Text>
              </View>
            </View>
          </View>

          {/* Follow / Unfollow button — hidden for the caller's own profile */}
          {!profile.is_me && (
            <TouchableOpacity
              className={`mt-4 flex-row items-center justify-center gap-2 rounded-xl py-2.5 px-4 ${
                isFollowing ? `border ${t.border} ${t.surface}` : t.primaryBg
              }`}
              onPress={() => followMutation.mutate({ following: isFollowing })}
              disabled={followMutation.isPending}
              activeOpacity={0.7}
            >
              {followMutation.isPending ? (
                <ActivityIndicator size="small" color={isFollowing ? t.colors.tabBarActive : "#fff"} />
              ) : (
                <>
                  <Ionicons
                    name={isFollowing ? "person-remove-outline" : "person-add-outline"}
                    size={16}
                    color={isFollowing ? t.colors.tabBarActive : "#fff"}
                  />
                  <Text
                    className={`text-sm font-semibold ${isFollowing ? t.textPrimary : "text-white"}`}
                  >
                    {isFollowing ? "Unfollow" : "Follow"}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>

        {/* Stats section */}
        {statsLoading ? (
          <View className="items-center py-8">
            <ActivityIndicator color={t.colors.tabBarActive} />
          </View>
        ) : stats && stats.rounds_counted > 0 ? (
          <>
            <Text className={`text-xs font-bold uppercase tracking-widest ${t.textTertiary} mb-3`}>
              Career Stats ({stats.rounds_counted} rounds)
            </Text>

            <StatCard
              label="Scoring"
              rows={[
                { label: "Avg gross / round", value: fmt(stats.avg_gross_per_round, 1) },
                { label: "Low round", value: fmt(stats.low_round, 0) },
                { label: "High round", value: fmt(stats.high_round, 0) },
              ]}
            />

            <StatCard
              label="Par Breakdown"
              rows={[
                { label: "Eagles", value: String(stats.eagles) },
                { label: "Birdies", value: String(stats.birdies) },
                { label: "Pars", value: String(stats.pars) },
                { label: "Bogeys", value: String(stats.bogeys) },
                { label: "Double +", value: String(stats.double_plus) },
              ]}
            />

            {(stats.fir_pct != null || stats.gir_pct != null || stats.avg_putts_per_round != null) && (
              <StatCard
                label="Advanced"
                rows={[
                  { label: "FIR %", value: stats.fir_pct != null ? `${fmt(stats.fir_pct, 1)}%` : "—" },
                  { label: "GIR %", value: stats.gir_pct != null ? `${fmt(stats.gir_pct, 1)}%` : "—" },
                  { label: "Avg putts / round", value: fmt(stats.avg_putts_per_round, 1) },
                ]}
              />
            )}
          </>
        ) : stats ? (
          <View className={`${t.surface} rounded-2xl border ${t.border} p-6 items-center`}>
            <Ionicons name="golf-outline" size={32} color={t.colors.tabBarInactive} />
            <Text className={`text-sm mt-2 ${t.textTertiary}`}>No completed rounds yet.</Text>
          </View>
        ) : null}

        {/* Bottom padding */}
        <View className="h-8" />
      </ScrollView>
    </View>
  );
}
