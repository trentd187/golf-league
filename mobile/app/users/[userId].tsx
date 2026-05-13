// app/users/[userId].tsx
// Public profile screen for any registered user.
//
// Shows the same stats display as the personal Stats screen (Scoring, Driving,
// Approach, Putting) computed from the player's last 20 completed rounds.
// No filter picker — always "last 20" for public profiles.
//
// Data flow:
//   1. GET /users/:userId        — profile card (name, avatar, rounds/events counts)
//   2. GET /users/:userId/rounds — IDs + dates of last 20 completed rounds
//   3. GET /rounds/:id/scorecard — fetched in parallel for each round
//   4. buildMyStats(scorecards, rounds, userId) — client-side stat computation
//      identical to the personal stats screen (userId param finds the target player)
//
// Navigated to from:
//   - profile tab Following list → tap player row
//   - profile tab "Find Players" → search screen → tap row
//   - event detail members list → tap member row
//   - round detail group player list → tap player row

import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient, useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import { apiFetch } from "@/utils/api";
import UserAvatar from "@/components/UserAvatar";
import { ScoringCard, DirectionalMissCard, PuttingCard } from "@/components/StatCards";
import HandicapSection from "@/components/HandicapSection";
import { buildMyStats, buildGirByBand } from "@/utils/stats";
import type { Scorecard, UserHandicapStats } from "@/types/scorecard";

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

// UserRoundRef is the shape returned by GET /users/:userId/rounds.
type UserRoundRef = { id: string; scheduled_date: string };

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

  // Fetch the user's last 20 completed round IDs so we can load their scorecards.
  // Handicap index and anti-handicap — always last 20 rounds, computed server-side.
  const { data: hcStats, isLoading: hcLoading } = useQuery<UserHandicapStats>({
    queryKey: ["userStats", userId],
    queryFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/users/${userId}/stats`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`);
      return res.json();
    },
    enabled: !!userId,
  });

  const { data: roundRefs, isLoading: roundsLoading } = useQuery<UserRoundRef[]>({
    queryKey: ["user", userId, "rounds"],
    queryFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/users/${userId}/rounds`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to fetch rounds: ${res.status}`);
      return res.json();
    },
    enabled: !!userId && !!profile,
  });

  // Fetch scorecards for each of the user's rounds in parallel.
  const scorecardQueries = useQueries({
    queries: (roundRefs ?? []).map((round) => ({
      queryKey: ["scorecard", round.id],
      queryFn: async () => {
        const token = await getToken();
        const res = await apiFetch(`${API_URL}/api/v1/rounds/${round.id}/scorecard`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`Failed to fetch scorecard: ${res.status}`);
        return res.json() as Promise<Scorecard>;
      },
      enabled: (roundRefs ?? []).length > 0,
    })),
  });

  const scorecardsLoading = scorecardQueries.some((q) => q.isLoading);
  const scorecards = scorecardQueries
    .map((q) => q.data)
    .filter((sc): sc is Scorecard => sc !== undefined);

  // Compute stats using the same function as the personal stats screen, passing
  // userId so buildMyStats finds this player instead of the caller.
  const stats    = useMemo(
    () => buildMyStats(scorecards, roundRefs ?? [], userId),
    [scorecards, roundRefs, userId]
  );
  const girBands = useMemo(
    () => buildGirByBand(scorecards, userId),
    [scorecards, userId]
  );

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
      queryClient.setQueryData<UserProfile>(["user", userId], (prev) =>
        prev ? { ...prev, is_following: !following } : prev
      );
      // Optimistically update the profile tab's cached following list so the change
      // is visible immediately. invalidateQueries alone only refetches if the query
      // has an active observer at this moment, which is not guaranteed when navigating
      // outside the tab group.
      type FollowingUser = { id: string; display_name: string; avatar_url: string | null; rounds_played: number };
      if (following) {
        // Unfollowed — remove from list.
        queryClient.setQueryData<FollowingUser[]>(["users", "following"], (prev) =>
          prev ? prev.filter((u) => u.id !== userId) : prev
        );
      } else {
        // Followed — append to list using cached profile data.
        const profileData = queryClient.getQueryData<UserProfile>(["user", userId]);
        if (profileData) {
          queryClient.setQueryData<FollowingUser[]>(["users", "following"], (prev) => {
            if (!prev) return prev;
            if (prev.some((u) => u.id === userId)) return prev;
            return [
              ...prev,
              {
                id: userId,
                display_name: profileData.display_name,
                avatar_url: profileData.avatar_url,
                rounds_played: profileData.rounds_played,
              },
            ];
          });
        }
      }
      // Invalidate so the list syncs with the server on next active fetch.
      queryClient.invalidateQueries({ queryKey: ["users", "following"] });
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
  const statsReady  = !roundsLoading && !scorecardsLoading;

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

          {/* Follow / Unfollow — hidden for own profile */}
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
                  <Text className={`text-sm font-semibold ${isFollowing ? t.textPrimary : "text-white"}`}>
                    {isFollowing ? "Unfollow" : "Follow"}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>

        {/* Stats section */}
        {!statsReady ? (
          <View className="items-center py-8">
            <ActivityIndicator color={t.colors.tabBarActive} />
          </View>
        ) : stats.rounds === 0 ? (
          <View className={`${t.surface} rounded-2xl border ${t.border} p-6 items-center gap-2`}>
            <Ionicons name="golf-outline" size={32} color={t.colors.tabBarInactive} />
            <Text className={`text-sm mt-2 ${t.textTertiary}`}>No completed rounds yet.</Text>
          </View>
        ) : (
          <>
            <Text className={`text-xs font-bold uppercase tracking-widest ${t.textTertiary} mb-3`}>
              Stats · Last {stats.rounds} round{stats.rounds === 1 ? "" : "s"}
            </Text>

            <HandicapSection
              handicapIndex={hcStats?.handicap_index}
              antiHandicap={hcStats?.anti_handicap}
              loading={hcLoading}
            />
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
            />
            <DirectionalMissCard
              sectionLabel="Approach"
              centerLabel="GIR"
              centerValue={stats.girPercent === null ? "—" : `${stats.girPercent.toFixed(0)}%`}
              miss={stats.girMiss}
              denominator={stats.girTotal}
              naValue={stats.girNaPercent === null ? "—" : `${stats.girNaPercent.toFixed(0)}%`}
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
        )}

        <View className="h-8" />
      </ScrollView>
    </View>
  );
}
