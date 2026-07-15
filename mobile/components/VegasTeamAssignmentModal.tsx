// components/VegasTeamAssignmentModal.tsx
// Organizer modal for assigning a Las Vegas group's players into two teams of two.
// Each player is toggled onto Team 1 or Team 2 (capped at two per side). Saving sends the
// whole desired set to PUT .../groups/:groupId/teams, which replaces the group's teams in ONE
// backend transaction — so a failed save leaves the previous partnerships intact. The team
// bookkeeping math lives in utils/vegasTeams.ts; this component renders + persists.

import { useEffect, useState } from "react";
import { Modal, Text, View, TouchableOpacity, ActivityIndicator } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import { savePut, FOREGROUND_SAVE } from "@/utils/saveRequest";
import { showAlert } from "@/utils/alerts";
import ModalHeader from "@/components/ModalHeader";
import {
  seedAssignment,
  partitionAssignment,
  isCompleteVegasPartition,
  sideCounts,
  type VegasTeamSummary,
} from "@/utils/vegasTeams";

interface GroupPlayerLite {
  round_player_id: string;
  display_name: string;
}

interface VegasTeamAssignmentModalProps {
  visible: boolean;
  onClose: () => void;
  roundId: string;
  group: { id: string; group_number: number; players: GroupPlayerLite[] };
  groupTeams: VegasTeamSummary[];
}

// firstNames joins a side's player first names for a friendly team label.
function firstNames(rpIds: string[], nameByRp: Record<string, string>): string {
  return rpIds.map((rp) => (nameByRp[rp] ?? "Player").split(" ")[0]).join(" & ");
}

export default function VegasTeamAssignmentModal({
  visible,
  onClose,
  roundId,
  group,
  groupTeams,
}: VegasTeamAssignmentModalProps) {
  const t = useTheme();
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const [assignment, setAssignment] = useState<Record<string, 1 | 2>>({});

  const groupRpIds = group.players.map((p) => p.round_player_id);
  const nameByRp: Record<string, string> = {};
  for (const p of group.players) nameByRp[p.round_player_id] = p.display_name;

  // Seed from existing teams each time the modal opens.
  useEffect(() => {
    if (visible) setAssignment(seedAssignment(groupRpIds, groupTeams));
    // groupRpIds/groupTeams are derived from props; visible is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const counts = sideCounts(assignment);

  // setSide assigns a player to a side, or clears it when tapping the active side.
  const setSide = (rpId: string, side: 1 | 2) => {
    setAssignment((prev) => {
      if (prev[rpId] === side) {
        const next = { ...prev };
        delete next[rpId];
        return next;
      }
      return { ...prev, [rpId]: side };
    });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const token = await getToken();
      const { team1, team2 } = partitionAssignment(assignment);

      // ONE atomic request. This used to be a loop: DELETE every existing team, then POST
      // each new team and PUT its members — separate calls. Each was individually hardened,
      // but the SEQUENCE was not atomic: if a create failed after the deletes landed (a
      // cellular drop past the retry budget, a 5xx), the group was left with NO TEAMS AT ALL
      // and the previous partnerships were gone. Real data loss, mid-round, on exactly the
      // network this app is built for.
      //
      // PUT .../groups/:groupId/teams replaces the group's whole team set in a single backend
      // transaction, so any failure leaves the old teams intact. It's a set-replace, hence
      // idempotent, hence safe for savePut's retry + Idempotency-Key.
      await savePut({
        url: `${API_URL}/api/v1/rounds/${roundId}/groups/${group.id}/teams`,
        token: token ?? "",
        body: {
          teams: [team1, team2]
            .filter((rpIds) => rpIds.length > 0)
            .map((rpIds) => ({
              name: firstNames(rpIds, nameByRp) || "Team",
              round_player_ids: rpIds,
            })),
        },
        label: "group-teams",
        retry: FOREGROUND_SAVE,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["round-teams", roundId] });
      queryClient.invalidateQueries({ queryKey: ["scorecard", roundId] });
      onClose();
    },
    onError: (err: Error) => showAlert("Could not save teams", err.message),
  });

  const complete = isCompleteVegasPartition(assignment);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/40">
        <View className={`rounded-t-3xl ${t.screen} max-h-[80%]`}>
          <View className="px-5 pt-5">
            <ModalHeader title={`Group ${group.group_number} Teams`} onClose={onClose} />
          </View>

          <View className="px-5 pb-8">
            <Text className={`text-xs mb-4 ${t.textTertiary}`}>
              Assign each player to a team. Two per side makes a Vegas match.
            </Text>

            {group.players.map((p) => {
              const side = assignment[p.round_player_id];
              return (
                <View key={p.round_player_id} className="flex-row items-center justify-between mb-3">
                  <Text className={`flex-1 text-base ${t.textPrimary}`} numberOfLines={1}>
                    {p.display_name}
                  </Text>
                  <View className="flex-row gap-2">
                    {([1, 2] as const).map((s) => {
                      const active = side === s;
                      const full = counts[s === 1 ? "team1" : "team2"] >= 2 && !active;
                      return (
                        <TouchableOpacity
                          key={s}
                          className={`px-4 py-2 rounded-lg border ${
                            active ? `${t.primaryBg} border-transparent` : `${t.surface} ${t.borderInput}`
                          } ${full ? "opacity-40" : ""}`}
                          disabled={full || saveMutation.isPending}
                          onPress={() => setSide(p.round_player_id, s)}
                        >
                          <Text className={`text-sm font-semibold ${active ? "text-white" : t.textSecondary}`}>
                            Team {s}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              );
            })}

            {!complete && (
              <Text className={`text-xs mt-1 ${t.textTertiary}`}>
                Tip: assign exactly two players to each team for a full matchup.
              </Text>
            )}

            <TouchableOpacity
              className={`mt-5 rounded-xl py-3.5 items-center ${t.primaryBg} ${saveMutation.isPending ? "opacity-60" : ""}`}
              disabled={saveMutation.isPending}
              onPress={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text className="text-white font-semibold text-base">Save Teams</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
