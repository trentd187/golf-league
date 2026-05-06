// components/HandicapSection.tsx
// Displays a player's Handicap Index, Anti-Handicap, and consistency spread.
// Used by both the personal stats tab (stats.tsx) and public user profiles
// (users/[userId].tsx). Data comes from GET /api/v1/users/:userId/stats.

import { Alert, View, Text, TouchableOpacity, ActivityIndicator } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { handicapConsistencyLabel } from "@/utils/stats";

const INFO_TITLE = "Handicap & Anti-Handicap";
const INFO_BODY =
  "Your Handicap Index is the average of your 8 best score differentials from your last 20 rounds × 0.96 — the lower the better.\n\n" +
  "Your Anti-Handicap is the average of your 8 worst differentials — a measure of how bad your bad rounds are.\n\n" +
  "The spread between them is your consistency score: a small gap means reliable scoring, a large gap means boom-or-bust tendencies.";

export default function HandicapSection({
  handicapIndex,
  antiHandicap,
  loading,
}: Readonly<{
  handicapIndex: number | null | undefined;
  antiHandicap:  number | null | undefined;
  loading:       boolean;
}>) {
  const t = useTheme();

  const hasData = handicapIndex != null && antiHandicap != null;
  const spread  = hasData ? (antiHandicap - handicapIndex).toFixed(1) : null;
  const label   = hasData ? handicapConsistencyLabel(handicapIndex, antiHandicap) : null;

  return (
    <View className={`rounded-2xl border ${t.border} ${t.surface} overflow-hidden mb-4`}>

      {/* Header row */}
      <View className={`flex-row items-center justify-between px-4 py-3 border-b ${t.divider}`}>
        <Text className={`text-sm font-bold uppercase tracking-wide ${t.textTertiary}`}>
          Handicap
        </Text>
        <TouchableOpacity
          onPress={() => Alert.alert(INFO_TITLE, INFO_BODY)}
          hitSlop={12}
          activeOpacity={0.7}
        >
          <Ionicons name="information-circle-outline" size={18} color={t.colors.tabBarInactive} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View className="items-center py-6">
          <ActivityIndicator size="small" color={t.colors.tabBarActive} />
        </View>
      ) : !hasData ? (
        <View className="items-center py-6 px-4">
          <Text className={`text-sm text-center ${t.textTertiary}`}>
            Not enough rounds — need at least 3 with tee rating data.
          </Text>
        </View>
      ) : (
        <View className="px-4 py-4 gap-3">

          {/* Two stat columns */}
          <View className="flex-row">
            <View className="flex-1 items-center gap-1">
              <Text className={`text-xs ${t.textTertiary}`}>Handicap Index</Text>
              <Text className={`text-3xl font-bold ${t.textPrimary}`}>
                {handicapIndex.toFixed(1)}
              </Text>
            </View>
            <View className={`w-px ${t.border}`} />
            <View className="flex-1 items-center gap-1">
              <Text className={`text-xs ${t.textTertiary}`}>Anti-Handicap</Text>
              <Text className={`text-3xl font-bold ${t.textPrimary}`}>
                {antiHandicap.toFixed(1)}
              </Text>
            </View>
          </View>

          {/* Spread / consistency row */}
          <View className={`flex-row items-center justify-center gap-2 pt-1 border-t ${t.divider}`}>
            <Text className={`text-sm ${t.textSecondary}`}>
              {spread} spread
            </Text>
            <Text className={`text-xs ${t.textTertiary}`}>·</Text>
            <Text className={`text-sm font-semibold ${t.textSecondary}`}>
              {label}
            </Text>
          </View>

        </View>
      )}
    </View>
  );
}
