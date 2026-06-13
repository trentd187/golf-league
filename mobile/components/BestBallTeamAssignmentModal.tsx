// components/BestBallTeamAssignmentModal.tsx
// Organizer modal for partitioning a Best Ball group into free-form teams. Unlike
// Vegas (two fixed sides of two), Best Ball allows any number of teams of any size:
// the organizer can add team slots and assign each player to one. Saving deletes the
// group's existing teams and recreates them from the chosen partition — idempotent and
// simpler than reconciling individual membership changes. The team bookkeeping math
// lives in utils/bestBallTeams.ts; this component renders + persists.

import { useEffect, useState } from "react";
import { Modal, Text, View, TouchableOpacity, ActivityIndicator, ScrollView } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import { apiFetch } from "@/utils/api";
import { showAlert } from "@/utils/alerts";
import ModalHeader from "@/components/ModalHeader";
import {
  seedAssignment,
  partitionAssignment,
  isValidBestBallPartition,
  type BestBallTeamSummary,
} from "@/utils/bestBallTeams";

interface GroupPlayerLite {
  round_player_id: string;
  display_name: string;
}

interface BestBallTeamAssignmentModalProps {
  visible: boolean;
  onClose: () => void;
  roundId: string;
  group: { id: string; group_number: number; players: GroupPlayerLite[] };
  groupTeams: BestBallTeamSummary[];
}

// firstNames joins a team's player first names for a friendly default team label.
function firstNames(rpIds: string[], nameByRp: Record<string, string>): string {
  return rpIds.map((rp) => (nameByRp[rp] ?? "Player").split(" ")[0]).join(" & ");
}

export default function BestBallTeamAssignmentModal({
  visible,
  onClose,
  roundId,
  group,
  groupTeams,
}: BestBallTeamAssignmentModalProps) {
  const t = useTheme();
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const [assignment, setAssignment] = useState<Record<string, number>>({});
  const [teamCount, setTeamCount] = useState(2);

  const groupRpIds = group.players.map((p) => p.round_player_id);
  const nameByRp: Record<string, string> = {};
  for (const p of group.players) nameByRp[p.round_player_id] = p.display_name;

  // Seed from existing teams each time the modal opens.
  useEffect(() => {
    if (visible) {
      const seed = seedAssignment(groupRpIds, groupTeams);
      setAssignment(seed.assignment);
      setTeamCount(seed.teamCount);
    }
    // groupRpIds/groupTeams are derived from props; visible is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // setTeam assigns a player to a team index, or clears it when tapping the active team.
  const setTeam = (rpId: string, idx: number) => {
    setAssignment((prev) => {
      if (prev[rpId] === idx) {
        const next = { ...prev };
        delete next[rpId];
        return next;
      }
      return { ...prev, [rpId]: idx };
    });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const token = await getToken();
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

      // 1. Remove the group's current teams (cascades team_members).
      for (const tm of groupTeams) {
        const res = await apiFetch(`${API_URL}/api/v1/rounds/${roundId}/teams/${tm.id}`, {
          method: "DELETE",
          headers,
        });
        if (!res.ok && res.status !== 404) throw new Error("Failed to clear existing teams");
      }

      // 2. Create + populate each non-empty team slot.
      const partitions = partitionAssignment(assignment, teamCount);
      let n = 0;
      for (const rpIds of partitions) {
        if (rpIds.length === 0) continue;
        n += 1;
        const createRes = await apiFetch(`${API_URL}/api/v1/rounds/${roundId}/teams`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name: firstNames(rpIds, nameByRp) || `Team ${n}` }),
        });
        if (!createRes.ok) throw new Error("Failed to create team");
        const team = (await createRes.json()) as { id: string };
        const assignRes = await apiFetch(`${API_URL}/api/v1/rounds/${roundId}/teams/${team.id}/members`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ round_player_ids: rpIds }),
        });
        if (!assignRes.ok) throw new Error("Failed to assign team members");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["round-teams", roundId] });
      queryClient.invalidateQueries({ queryKey: ["scorecard", roundId] });
      onClose();
    },
    onError: (err: Error) => showAlert("Could not save teams", err.message),
  });

  const valid = isValidBestBallPartition(assignment, teamCount);
  const teamIndexes = Array.from({ length: teamCount }, (_, i) => i);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/40">
        <View className={`rounded-t-3xl ${t.screen} max-h-[85%]`}>
          <View className="px-5 pt-5">
            <ModalHeader title={`Group ${group.group_number} Teams`} onClose={onClose} />
          </View>

          <ScrollView className="px-5" contentContainerStyle={{ paddingBottom: 32 }}>
            <Text className={`text-xs mb-4 ${t.textTertiary}`}>
              Assign each player to a team. Any number of teams of any size — the lowest
              ball on each team counts.
            </Text>

            {group.players.map((p) => {
              const cur = assignment[p.round_player_id];
              return (
                <View key={p.round_player_id} className="mb-3">
                  <Text className={`text-base mb-1.5 ${t.textPrimary}`} numberOfLines={1}>
                    {p.display_name}
                  </Text>
                  <View className="flex-row flex-wrap gap-2">
                    {teamIndexes.map((idx) => {
                      const active = cur === idx;
                      return (
                        <TouchableOpacity
                          key={idx}
                          className={`px-4 py-2 rounded-lg border ${
                            active ? `${t.primaryBg} border-transparent` : `${t.surface} ${t.borderInput}`
                          }`}
                          disabled={saveMutation.isPending}
                          onPress={() => setTeam(p.round_player_id, idx)}
                        >
                          <Text className={`text-sm font-semibold ${active ? "text-white" : t.textSecondary}`}>
                            Team {idx + 1}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              );
            })}

            {/* Add / remove team slots */}
            <View className="flex-row items-center gap-3 mt-1 mb-2">
              <TouchableOpacity
                className={`flex-row items-center gap-1.5 px-3 py-2 rounded-lg border ${t.borderInput} ${t.surface}`}
                disabled={saveMutation.isPending}
                onPress={() => setTeamCount((c) => c + 1)}
              >
                <Ionicons name="add" size={16} color={t.colors.tabBarInactive} />
                <Text className={`text-sm font-semibold ${t.textSecondary}`}>Add team</Text>
              </TouchableOpacity>
              {teamCount > 2 && (
                <TouchableOpacity
                  className={`flex-row items-center gap-1.5 px-3 py-2 rounded-lg border ${t.borderInput} ${t.surface}`}
                  disabled={saveMutation.isPending}
                  onPress={() =>
                    setTeamCount((c) => {
                      const next = Math.max(2, c - 1);
                      // Drop assignments that referenced the removed slot.
                      setAssignment((prev) => {
                        const cleaned: Record<string, number> = {};
                        for (const [rp, idx] of Object.entries(prev)) if (idx < next) cleaned[rp] = idx;
                        return cleaned;
                      });
                      return next;
                    })
                  }
                >
                  <Ionicons name="remove" size={16} color={t.colors.tabBarInactive} />
                  <Text className={`text-sm font-semibold ${t.textSecondary}`}>Remove team</Text>
                </TouchableOpacity>
              )}
            </View>

            {!valid && (
              <Text className={`text-xs mt-1 ${t.textTertiary}`}>
                Tip: fill at least two teams with one or more players each.
              </Text>
            )}

            <TouchableOpacity
              className={`mt-5 rounded-xl py-3.5 items-center ${t.primaryBg} ${saveMutation.isPending || !valid ? "opacity-60" : ""}`}
              disabled={saveMutation.isPending || !valid}
              onPress={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text className="text-white font-semibold text-base">Save Teams</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
