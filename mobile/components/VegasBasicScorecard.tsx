// components/VegasBasicScorecard.tsx
// The Basic (combined) scorecard view for a Las Vegas round, shown from the viewing
// player's team perspective. A compact, read-only summary grid (Hole | Par | You |
// Opp | +/- | Run) sits on top; tapping a hole expands a card where the four players'
// strokes are entered inline and combine live. All Vegas arithmetic comes from the
// pre-computed match (utils/vegas.ts) — this component only renders and captures input.

import { useState } from "react";
import { Text, View, TextInput, TouchableOpacity } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import type { ScorecardHole } from "@/types/scorecard";
import type { VegasRoundMatch, VegasTeamInfo, VegasMatchHole } from "@/utils/vegas";

interface VegasBasicScorecardProps {
  match: VegasRoundMatch; // from the viewing player's perspective (teamA = "You")
  holes: ScorecardHole[];
  scores: Record<string, Record<number, string>>; // rpId → hole → gross string
  onChangeScore: (roundPlayerId: string, hole: number, value: string) => void;
  onBlurScore: (roundPlayerId: string) => void;
  canEdit: (roundPlayerId: string) => boolean;
  saveError: Record<string, boolean>;
  editableDisabled: boolean; // true while handicaps are saving or required-but-unset
}

// diffColor returns the theme class for a per-hole/running differential.
function diffColor(value: number, neutral: string): string {
  if (value > 0) return "text-green-600";
  if (value < 0) return "text-red-600";
  return neutral;
}

export default function VegasBasicScorecard({
  match,
  holes,
  scores,
  onChangeScore,
  onBlurScore,
  canEdit,
  saveError,
  editableDisabled,
}: VegasBasicScorecardProps) {
  const t = useTheme();
  const [expandedHole, setExpandedHole] = useState<number | null>(null);

  const holeByNumber = new Map<number, VegasMatchHole>(match.holes.map((h) => [h.holeNumber, h]));

  // numberText renders a team's combined number, marking a flip when one applied.
  const numberText = (natural: number | null, final: number | null, flipped: boolean): string => {
    if (final === null) return "–";
    return flipped ? `${natural}→${final}` : String(final);
  };

  return (
    <View className="mt-4">
      {/* ── Matchup header ─────────────────────────────────────────────────── */}
      <View className={`rounded-xl border ${t.border} ${t.surfaceSunken} p-3 mb-3`}>
        <View className="flex-row items-center justify-between">
          <View className="flex-1 pr-2">
            <Text className={`text-xs font-bold ${t.textTertiary}`}>YOUR TEAM</Text>
            <Text className={`text-sm font-semibold ${t.textPrimary}`} numberOfLines={1}>
              {match.teamA.playerNames.join(" & ") || match.teamA.name}
            </Text>
          </View>
          <View className="items-center px-2">
            <Text className={`text-xs ${t.textTertiary}`}>RUNNING</Text>
            <Text className={`text-lg font-bold ${diffColor(match.finalTotalA, t.textPrimary)}`}>
              {match.finalTotalA > 0 ? `+${match.finalTotalA}` : match.finalTotalA}
            </Text>
          </View>
          <View className="flex-1 pl-2 items-end">
            <Text className={`text-xs font-bold ${t.textTertiary}`}>OPPONENTS</Text>
            <Text className={`text-sm font-semibold ${t.textPrimary}`} numberOfLines={1}>
              {match.teamB.playerNames.join(" & ") || match.teamB.name}
            </Text>
          </View>
        </View>
      </View>

      {/* ── Compact summary grid (tap a hole to enter/expand) ──────────────── */}
      <View className={`rounded-xl border ${t.border} overflow-hidden`}>
        {/* Header row */}
        <View className={`flex-row items-center px-3 py-2 ${t.surfaceSunken} border-b ${t.divider}`}>
          <Text style={{ width: 36 }} className={`text-xs font-bold text-center ${t.textTertiary}`}>H</Text>
          <Text style={{ width: 34 }} className={`text-xs font-bold text-center ${t.textTertiary}`}>Par</Text>
          <Text className={`flex-1 text-xs font-bold text-center ${t.textTertiary}`}>You</Text>
          <Text className={`flex-1 text-xs font-bold text-center ${t.textTertiary}`}>Opp</Text>
          <Text style={{ width: 48 }} className={`text-xs font-bold text-center ${t.textTertiary}`}>+/-</Text>
          <Text style={{ width: 48 }} className={`text-xs font-bold text-center ${t.textTertiary}`}>Run</Text>
        </View>

        {holes.map((hole, idx) => {
          const res = holeByNumber.get(hole.hole_number);
          const isOpen = expandedHole === hole.hole_number;
          const isOdd = idx % 2 === 0;
          return (
            <View key={hole.hole_number}>
              <TouchableOpacity
                className={`flex-row items-center px-3 py-2 border-b ${t.divider} ${isOdd ? t.surface : t.surfaceSunken}`}
                onPress={() => setExpandedHole(isOpen ? null : hole.hole_number)}
                activeOpacity={0.7}
              >
                <Text style={{ width: 36 }} className={`text-sm font-semibold text-center ${t.textPrimary}`}>
                  {hole.hole_number}
                </Text>
                <Text style={{ width: 34 }} className={`text-xs text-center ${hole.par ? t.textSecondary : t.textTertiary}`}>
                  {hole.par || "—"}
                </Text>
                <Text className={`flex-1 text-sm text-center ${t.textPrimary}`}>
                  {numberText(res?.teamANatural ?? null, res?.teamANumber ?? null, res?.flipAppliedToA ?? false)}
                </Text>
                <Text className={`flex-1 text-sm text-center ${t.textPrimary}`}>
                  {numberText(res?.teamBNatural ?? null, res?.teamBNumber ?? null, res?.flipAppliedToB ?? false)}
                </Text>
                <Text style={{ width: 48 }} className={`text-sm font-semibold text-center ${res?.complete ? diffColor(res.pointsA, t.textTertiary) : t.textTertiary}`}>
                  {res?.complete ? (res.pointsA > 0 ? `+${res.pointsA}` : res.pointsA) : "–"}
                </Text>
                <Text style={{ width: 48 }} className={`text-sm font-semibold text-center ${diffColor(res?.runningTotalA ?? 0, t.textTertiary)}`}>
                  {res ? (res.runningTotalA > 0 ? `+${res.runningTotalA}` : res.runningTotalA) : "–"}
                </Text>
              </TouchableOpacity>

              {isOpen && (
                <VegasHoleEntryCard
                  hole={hole}
                  result={res}
                  teamA={match.teamA}
                  teamB={match.teamB}
                  scores={scores}
                  onChangeScore={onChangeScore}
                  onBlurScore={onBlurScore}
                  canEdit={canEdit}
                  saveError={saveError}
                  editableDisabled={editableDisabled}
                />
              )}
            </View>
          );
        })}

        {/* Totals row */}
        <View className={`flex-row items-center px-3 py-2.5 ${t.surfaceSunken} border-t-2 ${t.border}`}>
          <Text style={{ width: 36 }} className={`text-xs font-bold text-center ${t.textTertiary}`}>TOT</Text>
          <View style={{ width: 34 }} />
          <View className="flex-1" />
          <View className="flex-1" />
          <View style={{ width: 48 }} />
          <Text style={{ width: 48 }} className={`text-sm font-bold text-center ${diffColor(match.finalTotalA, t.textPrimary)}`}>
            {match.finalTotalA > 0 ? `+${match.finalTotalA}` : match.finalTotalA}
          </Text>
        </View>
      </View>
    </View>
  );
}

// ─── Expanded per-hole entry card ───────────────────────────────────────────────

interface VegasHoleEntryCardProps {
  hole: ScorecardHole;
  result: VegasMatchHole | undefined;
  teamA: VegasTeamInfo;
  teamB: VegasTeamInfo;
  scores: Record<string, Record<number, string>>;
  onChangeScore: (roundPlayerId: string, hole: number, value: string) => void;
  onBlurScore: (roundPlayerId: string) => void;
  canEdit: (roundPlayerId: string) => boolean;
  saveError: Record<string, boolean>;
  editableDisabled: boolean;
}

function VegasHoleEntryCard({
  hole,
  result,
  teamA,
  teamB,
  scores,
  onChangeScore,
  onBlurScore,
  canEdit,
  saveError,
  editableDisabled,
}: VegasHoleEntryCardProps) {
  const t = useTheme();

  // teamRow renders one team's two editable stroke inputs + its combined number.
  const teamRow = (team: VegasTeamInfo, label: string, natural: number | null, final: number | null, flipped: boolean) => (
    <View className="mb-3">
      <Text className={`text-xs font-bold mb-1.5 ${t.textTertiary}`}>{label}</Text>
      <View className="flex-row items-center gap-2">
        {team.roundPlayerIds.map((rpId, i) => {
          const editable = canEdit(rpId) && !editableDisabled;
          return (
            <View key={rpId} className="flex-1">
              <Text className={`text-xs mb-0.5 ${t.textTertiary}`} numberOfLines={1}>
                {team.playerNames[i]?.split(" ")[0] ?? "Player"}
                {saveError[rpId] ? " ⚠︎" : ""}
              </Text>
              <TextInput
                className={`border rounded-lg text-center text-base py-1.5 ${t.borderInput} ${t.surface} ${t.textPrimary}`}
                keyboardType="number-pad"
                maxLength={2}
                value={scores[rpId]?.[hole.hole_number] ?? ""}
                onChangeText={(v) => onChangeScore(rpId, hole.hole_number, v)}
                onBlur={() => onBlurScore(rpId)}
                editable={editable}
                placeholder="–"
                placeholderTextColor={t.colors.tabBarInactive}
              />
            </View>
          );
        })}
        <View className="items-center" style={{ width: 64 }}>
          <Text className={`text-xs mb-0.5 ${t.textTertiary}`}>Combined</Text>
          <Text className={`text-base font-bold ${t.textPrimary}`}>
            {final === null ? "–" : final}
          </Text>
          {flipped && <Text className="text-[10px] text-amber-600">flip {natural}→{final}</Text>}
        </View>
      </View>
    </View>
  );

  return (
    <View className={`px-3 py-3 border-b ${t.divider} ${t.surfaceSunken}`}>
      {teamRow(teamA, "YOUR TEAM", result?.teamANatural ?? null, result?.teamANumber ?? null, result?.flipAppliedToA ?? false)}
      {teamRow(teamB, "OPPONENTS", result?.teamBNatural ?? null, result?.teamBNumber ?? null, result?.flipAppliedToB ?? false)}
      <View className={`flex-row items-center justify-between pt-2 border-t ${t.divider}`}>
        <Text className={`text-xs ${t.textTertiary}`}>
          Hole {hole.hole_number} · Par {hole.par || "—"}
        </Text>
        {result?.complete ? (
          <Text className={`text-sm font-semibold ${diffColor(result.pointsA, t.textSecondary)}`}>
            {result.pointsA > 0 ? `You +${result.pointsA}` : result.pointsA < 0 ? `You ${result.pointsA}` : "Tied"}
            {"  ·  Run "}
            {result.runningTotalA > 0 ? `+${result.runningTotalA}` : result.runningTotalA}
          </Text>
        ) : (
          <Text className={`text-xs ${t.textTertiary}`}>Enter all four scores</Text>
        )}
      </View>
    </View>
  );
}
