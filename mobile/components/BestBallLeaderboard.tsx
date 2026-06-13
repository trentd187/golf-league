// components/BestBallLeaderboard.tsx
// Read-only standings table for one Best Ball group: teams ranked by cumulative
// best-ball total (lowest wins), showing rank, the team's players, holes counted
// ("thru"), and the total. Ranking + totals are pre-computed in utils/bestBall.ts
// (buildStandings) — this component only renders. Reused inside BestBallMatchCard
// and anywhere a bare team leaderboard is needed.

import { Text, View } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import type { BestBallTeamStanding } from "@/utils/bestBall";

interface BestBallLeaderboardProps {
  standings: BestBallTeamStanding[];
  holeCount: number; // total holes in the round, for the "thru" column
}

export default function BestBallLeaderboard({ standings, holeCount }: BestBallLeaderboardProps) {
  const t = useTheme();

  return (
    <View className={`rounded-2xl border ${t.border} overflow-hidden`}>
      {/* Header */}
      <View className={`flex-row items-center px-4 py-2 ${t.surfaceSunken} border-b ${t.divider}`}>
        <Text style={{ width: 32 }} className={`text-xs font-bold ${t.textTertiary}`}>#</Text>
        <Text className={`flex-1 text-xs font-bold ${t.textTertiary}`}>Team</Text>
        <Text style={{ width: 52 }} className={`text-xs font-bold text-center ${t.textTertiary}`}>Thru</Text>
        <Text style={{ width: 52 }} className={`text-xs font-bold text-center ${t.textTertiary}`}>Total</Text>
      </View>

      {standings.map((s, idx) => (
        <View
          key={s.teamId}
          className={`flex-row items-center px-4 py-2.5 border-b ${t.divider} ${idx % 2 === 0 ? t.surface : t.surfaceSunken}`}
        >
          <Text style={{ width: 32 }} className={`text-sm font-bold ${s.rank === 1 ? "text-green-700" : t.textSecondary}`}>
            {s.rank}
          </Text>
          <View className="flex-1 pr-2">
            <Text className={`text-sm font-medium ${t.textPrimary}`} numberOfLines={1}>
              {s.name}
            </Text>
            <Text className={`text-[11px] ${t.textTertiary}`} numberOfLines={1}>
              {s.playerNames.map((n) => n.split(" ")[0]).join(" · ")}
            </Text>
          </View>
          <Text style={{ width: 52 }} className={`text-sm text-center ${t.textSecondary}`}>
            {s.holesCounted}/{holeCount}
          </Text>
          <Text style={{ width: 52 }} className={`text-sm font-bold text-center ${t.textPrimary}`}>
            {s.total}
          </Text>
        </View>
      ))}
    </View>
  );
}
