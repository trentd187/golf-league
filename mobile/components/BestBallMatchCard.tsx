// components/BestBallMatchCard.tsx
// Read-only card rendering one Best Ball group's result: the team leaderboard on top
// (via BestBallLeaderboard) plus a tap-to-expand hole-by-hole grid showing each team's
// best score per hole, with the hole's lowest (winning) team highlighted. Used by the
// round Teams tab and the event per-round detail. All values are pre-computed in
// utils/bestBall.ts — this component only renders.

import { useState } from "react";
import { Text, View, TouchableOpacity } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import BestBallLeaderboard from "@/components/BestBallLeaderboard";
import type { BestBallRoundMatch } from "@/utils/bestBall";

interface BestBallMatchCardProps {
  match: BestBallRoundMatch;
  holeCount: number;
  // title overrides the default "Group N" header (e.g. a round name in the event tab).
  title?: string;
}

export default function BestBallMatchCard({ match, holeCount, title }: BestBallMatchCardProps) {
  const t = useTheme();
  const [showHoles, setShowHoles] = useState(false);

  // teamOrder fixes the column order to the match's team order for the hole grid.
  const teamOrder = match.teams;

  return (
    <View className={`rounded-2xl border ${t.border} ${t.surface} overflow-hidden`}>
      {/* Header */}
      <View className={`px-4 py-3 ${t.surfaceSunken} border-b ${t.divider}`}>
        <Text className={`text-sm font-bold ${t.textPrimary}`}>{title ?? `Group ${match.groupNumber}`}</Text>
        <Text className={`text-[11px] ${t.textTertiary}`}>
          {match.complete ? "Final" : "In progress"} · lowest team total wins
        </Text>
      </View>

      {/* Leaderboard */}
      <View className="p-3">
        <BestBallLeaderboard standings={match.standings} holeCount={holeCount} />
      </View>

      {/* Hole-by-hole toggle */}
      <TouchableOpacity
        className={`flex-row items-center justify-center gap-1.5 px-4 py-2.5 border-t ${t.divider} ${t.surfaceSunken}`}
        onPress={() => setShowHoles((v) => !v)}
        activeOpacity={0.7}
      >
        <Text className={`text-xs font-semibold ${t.textSecondary}`}>
          {showHoles ? "Hide" : "Show"} hole-by-hole
        </Text>
        <Ionicons name={showHoles ? "chevron-up" : "chevron-down"} size={14} color={t.colors.tabBarInactive} />
      </TouchableOpacity>

      {showHoles && (
        <View>
          {/* Column header: H | per-team */}
          <View className={`flex-row items-center px-3 py-1.5 ${t.surfaceSunken} border-b ${t.divider}`}>
            <Text style={{ width: 30 }} className={`text-[11px] font-bold text-center ${t.textTertiary}`}>H</Text>
            {teamOrder.map((team) => (
              <Text
                key={team.teamId}
                className={`flex-1 text-[11px] font-bold text-center ${t.textTertiary}`}
                numberOfLines={1}
              >
                {team.name}
              </Text>
            ))}
          </View>

          {match.holes.map((h, idx) => {
            // Lowest complete team best on this hole is the hole winner (ties = both).
            const completeBests = h.teams.filter((th) => th.best !== null).map((th) => th.best as number);
            const holeMin = completeBests.length ? Math.min(...completeBests) : null;
            return (
              <View
                key={h.holeNumber}
                className={`flex-row items-center px-3 py-1 ${idx % 2 === 0 ? t.surface : t.surfaceSunken}`}
              >
                <Text style={{ width: 30 }} className={`text-xs text-center ${t.textPrimary}`}>{h.holeNumber}</Text>
                {teamOrder.map((team) => {
                  const th = h.teams.find((x) => x.teamId === team.teamId);
                  const isWinner = th?.best !== null && th?.best !== undefined && th.best === holeMin;
                  return (
                    <Text
                      key={team.teamId}
                      className={`flex-1 text-xs text-center ${
                        isWinner ? "font-bold text-green-600" : t.textSecondary
                      }`}
                    >
                      {th?.best ?? "–"}
                    </Text>
                  );
                })}
              </View>
            );
          })}

          {/* Totals row */}
          <View className={`flex-row items-center px-3 py-2 ${t.surfaceSunken} border-t-2 ${t.border}`}>
            <Text style={{ width: 30 }} className={`text-[11px] font-bold text-center ${t.textTertiary}`}>TOT</Text>
            {teamOrder.map((team) => {
              const standing = match.standings.find((s) => s.teamId === team.teamId);
              return (
                <Text key={team.teamId} className={`flex-1 text-xs font-bold text-center ${t.textPrimary}`}>
                  {standing?.total ?? 0}
                </Text>
              );
            })}
          </View>
        </View>
      )}
    </View>
  );
}
