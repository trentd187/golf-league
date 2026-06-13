// components/BestBallEventTally.tsx
// Cumulative Best Ball standings for an event: per player across all Best Ball rounds,
// showing team wins and total best-ball strokes, sorted best-first, with a tappable row
// that expands to each round's team, teammates, finishing rank, and total. Teams re-form
// each round, so the aggregation is per player (buildBestBallEventTally in
// utils/bestBall.ts); this component only renders.

import { useState } from "react";
import { Text, View, TouchableOpacity } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import type { BestBallEventPlayerTally } from "@/utils/bestBall";

interface BestBallEventTallyProps {
  tallies: BestBallEventPlayerTally[];
}

export default function BestBallEventTally({ tallies }: BestBallEventTallyProps) {
  const t = useTheme();
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <View className={`rounded-2xl border ${t.border} overflow-hidden`}>
      {/* Header */}
      <View className={`flex-row items-center px-4 py-2 ${t.surfaceSunken} border-b ${t.divider}`}>
        <Text style={{ width: 32 }} className={`text-xs font-bold ${t.textTertiary}`}>#</Text>
        <Text className={`flex-1 text-xs font-bold ${t.textTertiary}`}>Player</Text>
        <Text style={{ width: 48 }} className={`text-xs font-bold text-center ${t.textTertiary}`}>Wins</Text>
        <Text style={{ width: 56 }} className={`text-xs font-bold text-center ${t.textTertiary}`}>Strokes</Text>
      </View>

      {tallies.map((player, idx) => {
        const isOpen = expanded === player.userId;
        return (
          <View key={player.userId}>
            <TouchableOpacity
              className={`flex-row items-center px-4 py-2.5 border-b ${t.divider} ${idx % 2 === 0 ? t.surface : t.surfaceSunken}`}
              onPress={() => setExpanded(isOpen ? null : player.userId)}
              activeOpacity={0.7}
            >
              <Text style={{ width: 32 }} className={`text-sm font-semibold ${t.textSecondary}`}>{idx + 1}</Text>
              <Text className={`flex-1 text-sm font-medium ${t.textPrimary}`} numberOfLines={1}>
                {player.displayName}
              </Text>
              <Text style={{ width: 48 }} className={`text-sm font-bold text-center ${player.wins > 0 ? "text-green-600" : t.textSecondary}`}>
                {player.wins}
              </Text>
              <Text style={{ width: 56 }} className={`text-sm text-center ${t.textSecondary}`}>
                {player.totalStrokes}
              </Text>
            </TouchableOpacity>

            {isOpen && (
              <View className={`px-4 py-2 ${t.surfaceSunken} border-b ${t.divider}`}>
                {player.perRound.map((r) => (
                  <View key={r.roundId} className="flex-row items-start justify-between py-1.5">
                    <View className="flex-1 pr-2">
                      <Text className={`text-xs font-semibold ${t.textPrimary}`} numberOfLines={1}>
                        {r.roundName}
                      </Text>
                      <Text className={`text-[11px] ${t.textTertiary}`} numberOfLines={1}>
                        {r.teamName}
                        {r.teammateNames.length ? ` · with ${r.teammateNames.map((n) => n.split(" ")[0]).join(" & ")}` : ""}
                      </Text>
                    </View>
                    <Text className={`text-xs font-bold ${r.won ? "text-green-600" : t.textTertiary}`}>
                      {r.won ? "Win" : `#${r.rank}`} · {r.total}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        );
      })}

      {/* Footer hint */}
      <View className="px-4 py-2 flex-row items-center gap-1.5">
        <Ionicons name="information-circle-outline" size={13} color={t.colors.tabBarInactive} />
        <Text className={`text-[11px] ${t.textTertiary}`}>Tap a player to see each round{"'"}s team result.</Text>
      </View>
    </View>
  );
}
