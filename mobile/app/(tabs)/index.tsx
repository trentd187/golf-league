// app/(tabs)/index.tsx
// The Home screen — the first screen authenticated users see after signing in.
// Shows a personalised greeting and placeholder cards for events and rounds.

import { useUser } from "@clerk/clerk-expo";
import { Text, View, ScrollView, TouchableOpacity } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { useTheme } from "@/hooks/useTheme";

// HomeCard is a tappable section card linking to a main feature area.
function HomeCard({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: string;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  const t = useTheme();

  return (
    <TouchableOpacity
      className={`${t.surface} rounded-2xl p-5 mb-4 border ${t.border}`}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View className="flex-row items-center justify-between mb-2">
        <View className="flex-row items-center gap-3">
          <Ionicons name={icon as any} size={22} color={t.colors.tabBarActive} />
          <Text className={`text-lg font-semibold ${t.textPrimary}`}>{title}</Text>
        </View>
        <Ionicons name="chevron-forward-outline" size={20} color={t.colors.tabBarInactive} />
      </View>

      <Text className={`text-sm ${t.textSecondary}`}>{subtitle}</Text>
    </TouchableOpacity>
  );
}

export default function HomeScreen() {
  const { user, isLoaded } = useUser();
  const router = useRouter();
  const t = useTheme();

  if (!isLoaded) return null;

  // ?? is the nullish coalescing operator — uses the right side when the left is null/undefined.
  const greeting = user?.firstName ? `Welcome back, ${user.firstName}!` : "Welcome back!";

  return (
    <ScrollView className={`flex-1 ${t.screen}`}>
      <View className="px-5 pt-14 pb-6">

        <Text className={`text-2xl font-bold mb-1 ${t.textPrimary}`}>{greeting}</Text>
        <Text className={`text-sm mb-8 ${t.textSecondary}`}>{"Here's what's happening in your events."}</Text>

        <Text className={`text-xs font-semibold uppercase tracking-widest mb-3 ${t.textTertiary}`}>
          Quick Access
        </Text>

        <HomeCard
          icon="trophy-outline"
          title="Your Events"
          subtitle="No active events yet. Join or create one to get started."
          onPress={() => router.push("/(tabs)/events")}
        />

        <HomeCard
          icon="flag-outline"
          title="Recent Rounds"
          subtitle="No rounds played yet. Start a round from an event to enter scores."
          onPress={() => router.push("/(tabs)/rounds")}
        />

      </View>
    </ScrollView>
  );
}
