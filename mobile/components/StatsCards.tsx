// components/StatsCards.tsx
// Renders a vertical list of stat category cards (Birdies, Putts, GIR, FIR).
// Used by the round detail screen, event detail screen, and the stats page.
//
// Each card shows up to 3 ranked rows. Pass the output of buildStats() from utils/stats.ts.

import { View, Text } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import type { StatSummary } from "@/types/scorecard";

export default function StatsCards({ stats }: { stats: StatSummary[] }) {
  const t = useTheme();
  return (
    <View className="gap-3">
      {stats.map((stat) => (
        <View
          key={stat.category}
          className={`${t.surface} rounded-2xl border ${t.border} overflow-hidden`}
        >
          <View className={`px-4 py-2.5 border-b ${t.divider} ${t.surfaceSunken}`}>
            <Text className={`text-xs font-semibold uppercase tracking-widest ${t.textTertiary}`}>
              {stat.category}
            </Text>
          </View>
          {stat.top3.length === 0 ? (
            <Text className={`text-sm italic px-4 py-3 ${t.textTertiary}`}>No data yet</Text>
          ) : (
            stat.top3.map((row, idx) => (
              <View
                key={row.rank}
                className={`flex-row items-center px-4 py-3 gap-3 ${
                  idx < stat.top3.length - 1 ? `border-b ${t.divider}` : ""
                }`}
              >
                <Text className={`w-7 text-sm font-bold ${t.textTertiary}`}>{row.rank}</Text>
                <Text
                  className={`flex-1 text-sm font-semibold ${t.textPrimary}`}
                  numberOfLines={1}
                >
                  {row.names.join(", ")}
                </Text>
                <Text className={`text-sm ${t.textSecondary}`}>
                  {row.value} {stat.unit}
                </Text>
              </View>
            ))
          )}
        </View>
      ))}
    </View>
  );
}
