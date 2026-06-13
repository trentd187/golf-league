// components/BestBallBasicScorecard.tsx
// The Basic (combined) scorecard view for a Best Ball round. A live team leaderboard
// sits on top; below, a compact grid (Hole | Par | one column per team's best) lets
// the organizer tap a hole to expand a card where every player's stroke is entered
// inline, grouped by team, and the team's counting (lowest) score is highlighted live.
// All Best Ball arithmetic comes from the pre-computed match (utils/bestBall.ts) — this
// component only renders and captures input.

import { useState } from "react";
import { Text, View, TextInput, TouchableOpacity } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import type { ScorecardHole } from "@/types/scorecard";
import BestBallLeaderboard from "@/components/BestBallLeaderboard";
import type { BestBallRoundMatch, BestBallTeamInfo, BestBallHoleResult } from "@/utils/bestBall";

interface BestBallBasicScorecardProps {
  match: BestBallRoundMatch;
  holes: ScorecardHole[];
  scores: Record<string, Record<number, string>>; // rpId → hole → gross string
  onChangeScore: (roundPlayerId: string, hole: number, value: string) => void;
  onBlurScore: (roundPlayerId: string) => void;
  canEdit: (roundPlayerId: string) => boolean;
  saveError: Record<string, boolean>;
  editableDisabled: boolean; // true while handicaps are saving or required-but-unset
}

export default function BestBallBasicScorecard({
  match,
  holes,
  scores,
  onChangeScore,
  onBlurScore,
  canEdit,
  saveError,
  editableDisabled,
}: BestBallBasicScorecardProps) {
  const t = useTheme();
  const [expandedHole, setExpandedHole] = useState<number | null>(null);

  const holeByNumber = new Map<number, BestBallHoleResult>(match.holes.map((h) => [h.holeNumber, h]));
  const teamOrder = match.teams;

  return (
    <View className="mt-4">
      {/* ── Live leaderboard ───────────────────────────────────────────────── */}
      <View className="mb-3">
        <BestBallLeaderboard standings={match.standings} holeCount={holes.length} />
      </View>

      {/* ── Compact summary grid (tap a hole to enter/expand) ──────────────── */}
      <View className={`rounded-xl border ${t.border} overflow-hidden`}>
        {/* Header row */}
        <View className={`flex-row items-center px-3 py-2 ${t.surfaceSunken} border-b ${t.divider}`}>
          <Text style={{ width: 32 }} className={`text-xs font-bold text-center ${t.textTertiary}`}>H</Text>
          <Text style={{ width: 30 }} className={`text-xs font-bold text-center ${t.textTertiary}`}>Par</Text>
          {teamOrder.map((team) => (
            <Text key={team.teamId} className={`flex-1 text-xs font-bold text-center ${t.textTertiary}`} numberOfLines={1}>
              {team.name}
            </Text>
          ))}
        </View>

        {holes.map((hole, idx) => {
          const res = holeByNumber.get(hole.hole_number);
          const isOpen = expandedHole === hole.hole_number;
          const isOdd = idx % 2 === 0;
          const completeBests = (res?.teams ?? []).filter((th) => th.best !== null).map((th) => th.best as number);
          const holeMin = completeBests.length ? Math.min(...completeBests) : null;
          return (
            <View key={hole.hole_number}>
              <TouchableOpacity
                className={`flex-row items-center px-3 py-2 border-b ${t.divider} ${isOdd ? t.surface : t.surfaceSunken}`}
                onPress={() => setExpandedHole(isOpen ? null : hole.hole_number)}
                activeOpacity={0.7}
              >
                <Text style={{ width: 32 }} className={`text-sm font-semibold text-center ${t.textPrimary}`}>
                  {hole.hole_number}
                </Text>
                <Text style={{ width: 30 }} className={`text-xs text-center ${hole.par ? t.textSecondary : t.textTertiary}`}>
                  {hole.par || "—"}
                </Text>
                {teamOrder.map((team) => {
                  const th = res?.teams.find((x) => x.teamId === team.teamId);
                  const isWinner = th?.best !== null && th?.best !== undefined && th.best === holeMin;
                  return (
                    <Text
                      key={team.teamId}
                      className={`flex-1 text-sm text-center ${isWinner ? "font-bold text-green-600" : t.textPrimary}`}
                    >
                      {th?.best ?? "–"}
                    </Text>
                  );
                })}
              </TouchableOpacity>

              {isOpen && (
                <BestBallHoleEntryCard
                  hole={hole}
                  result={res}
                  teams={teamOrder}
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
          <Text style={{ width: 32 }} className={`text-xs font-bold text-center ${t.textTertiary}`}>TOT</Text>
          <View style={{ width: 30 }} />
          {teamOrder.map((team) => {
            const standing = match.standings.find((s) => s.teamId === team.teamId);
            return (
              <Text key={team.teamId} className={`flex-1 text-sm font-bold text-center ${t.textPrimary}`}>
                {standing?.total ?? 0}
              </Text>
            );
          })}
        </View>
      </View>
    </View>
  );
}

// ─── Expanded per-hole entry card ───────────────────────────────────────────────

interface BestBallHoleEntryCardProps {
  hole: ScorecardHole;
  result: BestBallHoleResult | undefined;
  teams: BestBallTeamInfo[];
  scores: Record<string, Record<number, string>>;
  onChangeScore: (roundPlayerId: string, hole: number, value: string) => void;
  onBlurScore: (roundPlayerId: string) => void;
  canEdit: (roundPlayerId: string) => boolean;
  saveError: Record<string, boolean>;
  editableDisabled: boolean;
}

function BestBallHoleEntryCard({
  hole,
  result,
  teams,
  scores,
  onChangeScore,
  onBlurScore,
  canEdit,
  saveError,
  editableDisabled,
}: BestBallHoleEntryCardProps) {
  const t = useTheme();

  // teamRow renders one team's editable stroke inputs + its best-ball score, marking
  // the counting (lowest) player.
  const teamRow = (team: BestBallTeamInfo) => {
    const th = result?.teams.find((x) => x.teamId === team.teamId);
    return (
      <View key={team.teamId} className="mb-3">
        <View className="flex-row items-center justify-between mb-1.5">
          <Text className={`text-xs font-bold ${t.textTertiary}`} numberOfLines={1}>
            {team.name.toUpperCase()}
          </Text>
          <Text className={`text-xs font-semibold ${t.textSecondary}`}>
            Best: <Text className="font-bold text-green-600">{th?.best ?? "–"}</Text>
          </Text>
        </View>
        <View className="flex-row flex-wrap gap-2">
          {team.roundPlayerIds.map((rpId, i) => {
            const editable = canEdit(rpId) && !editableDisabled;
            const isOwner = th?.ownerRoundPlayerId === rpId && th?.best !== null;
            return (
              <View key={rpId} style={{ width: 76 }}>
                <Text className={`text-xs mb-0.5 ${isOwner ? "text-green-600 font-semibold" : t.textTertiary}`} numberOfLines={1}>
                  {team.playerNames[i]?.split(" ")[0] ?? "Player"}
                  {saveError[rpId] ? " ⚠︎" : ""}
                </Text>
                <TextInput
                  className={`border rounded-lg text-center text-base py-1.5 ${
                    isOwner ? "border-green-600" : t.borderInput
                  } ${t.surface} ${t.textPrimary}`}
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
        </View>
      </View>
    );
  };

  return (
    <View className={`px-3 py-3 border-b ${t.divider} ${t.surfaceSunken}`}>
      {teams.map((team) => teamRow(team))}
      <View className={`pt-2 border-t ${t.divider}`}>
        <Text className={`text-xs ${t.textTertiary}`}>
          Hole {hole.hole_number} · Par {hole.par || "—"} · lowest score on each team counts
        </Text>
      </View>
    </View>
  );
}
