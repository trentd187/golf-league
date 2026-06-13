// components/VegasMatchCard.tsx
// Read-only card rendering one Las Vegas team-vs-team match (one group, one round).
// Shows the two teams, their per-hole combined numbers and differential, the running
// total, and the final result. Differentials are from Team A's perspective. Used by
// the round Matches tab and the event per-round matchup detail. All values are
// pre-computed in utils/vegas.ts — this component only renders.

import { Text, View } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import type { VegasRoundMatch } from "@/utils/vegas";

interface VegasMatchCardProps {
  match: VegasRoundMatch;
  // title overrides the default "Group N" header (e.g. a round name in the event tab).
  title?: string;
}

// signed renders a signed integer with an explicit + for positives.
function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

export default function VegasMatchCard({ match, title }: VegasMatchCardProps) {
  const t = useTheme();

  const result =
    match.winner === "tie"
      ? "Tied"
      : match.winner === "A"
        ? `${match.teamA.name} +${match.finalTotalA}`
        : `${match.teamB.name} +${-match.finalTotalA}`;

  return (
    <View className={`rounded-2xl border ${t.border} ${t.surface} overflow-hidden`}>
      {/* Header: two teams + final result */}
      <View className={`px-4 py-3 ${t.surfaceSunken} border-b ${t.divider}`}>
        <View className="flex-row items-center justify-between">
          <Text className={`text-sm font-bold ${t.textPrimary}`}>
            {title ?? `Group ${match.groupNumber}`}
          </Text>
          <Text className={`text-sm font-bold ${match.winner === "tie" ? t.textSecondary : "text-green-700"}`}>
            {match.complete ? result : `${signed(match.finalTotalA)} (thru)`}
          </Text>
        </View>
        <View className="flex-row items-center justify-between mt-1">
          <Text className={`text-xs ${t.textSecondary}`} numberOfLines={1}>
            {match.teamA.playerNames.join(" & ") || match.teamA.name}
          </Text>
          <Text className={`text-xs ${t.textTertiary}`}>vs</Text>
          <Text className={`text-xs ${t.textSecondary}`} numberOfLines={1}>
            {match.teamB.playerNames.join(" & ") || match.teamB.name}
          </Text>
        </View>
      </View>

      {/* Hole-by-hole */}
      <View className={`flex-row items-center px-4 py-1.5 ${t.surfaceSunken} border-b ${t.divider}`}>
        <Text style={{ width: 34 }} className={`text-[11px] font-bold text-center ${t.textTertiary}`}>H</Text>
        <Text className={`flex-1 text-[11px] font-bold text-center ${t.textTertiary}`}>A</Text>
        <Text className={`flex-1 text-[11px] font-bold text-center ${t.textTertiary}`}>B</Text>
        <Text style={{ width: 44 }} className={`text-[11px] font-bold text-center ${t.textTertiary}`}>+/-</Text>
        <Text style={{ width: 44 }} className={`text-[11px] font-bold text-center ${t.textTertiary}`}>Run</Text>
      </View>

      {match.holes
        .filter((h) => h.complete)
        .map((h, idx) => (
          <View
            key={h.holeNumber}
            className={`flex-row items-center px-4 py-1 ${idx % 2 === 0 ? t.surface : t.surfaceSunken}`}
          >
            <Text style={{ width: 34 }} className={`text-xs text-center ${t.textPrimary}`}>{h.holeNumber}</Text>
            <Text className={`flex-1 text-xs text-center ${t.textSecondary}`}>{h.teamANumber}</Text>
            <Text className={`flex-1 text-xs text-center ${t.textSecondary}`}>{h.teamBNumber}</Text>
            <Text
              style={{ width: 44 }}
              className={`text-xs text-center font-semibold ${h.pointsA > 0 ? "text-green-600" : h.pointsA < 0 ? "text-red-600" : t.textTertiary}`}
            >
              {h.pointsA === 0 ? "0" : signed(h.pointsA)}
            </Text>
            <Text style={{ width: 44 }} className={`text-xs text-center ${t.textTertiary}`}>
              {signed(h.runningTotalA)}
            </Text>
          </View>
        ))}

      {match.holes.every((h) => !h.complete) && (
        <Text className={`px-4 py-3 text-xs text-center ${t.textTertiary}`}>
          No completed holes yet.
        </Text>
      )}
    </View>
  );
}
