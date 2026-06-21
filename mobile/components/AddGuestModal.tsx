// components/AddGuestModal.tsx
// Organizer modal for adding a score-only "guest" player to a tee-time group.
// Guests have no account — they exist only to track scores in a round (team games
// like Best Ball / Las Vegas, or any round). Captures a name (required) and an
// optional course handicap, then POSTs to the guests endpoint. Input validation /
// parsing lives in utils/guest.ts so this component stays presentational.

import { useState } from "react";
import {
  Modal,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import { savePost } from "@/utils/savePost";
import { showAlert } from "@/utils/alerts";
import ModalHeader from "@/components/ModalHeader";
import { validateGuestName, parseGuestHandicap } from "@/utils/guest";

interface AddGuestModalProps {
  visible: boolean;
  onClose: () => void;
  roundId: string;
  groupId: string | null;
}

export default function AddGuestModal({ visible, onClose, roundId, groupId }: AddGuestModalProps) {
  const t = useTheme();
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [handicap, setHandicap] = useState("");

  const reset = () => {
    setName("");
    setHandicap("");
  };

  const close = () => {
    reset();
    onClose();
  };

  const addGuestMutation = useMutation({
    mutationFn: async () => {
      const validated = validateGuestName(name);
      if (!validated.ok) throw new Error(validated.error);
      if (!groupId) throw new Error("No group selected");

      const token = await getToken();
      // savePost: stable Idempotency-Key + retry; the backend durable idempotency store
      // replays the original response so a cellular phantom (commit + lost ack) retry
      // can't create a duplicate guest (and its round_player/group_player rows).
      return savePost({
        url: `${API_URL}/api/v1/rounds/${roundId}/groups/${groupId}/guests`,
        token: token ?? "",
        body: {
          name: validated.value,
          course_handicap: parseGuestHandicap(handicap),
        },
        label: "guest",
      });
    },
    onSuccess: () => {
      // Refresh the group card and scorecard so the guest appears immediately.
      queryClient.invalidateQueries({ queryKey: ["round", roundId] });
      queryClient.invalidateQueries({ queryKey: ["scorecard", roundId] });
      close();
    },
    onError: (err: Error) => showAlert("Could not add guest", err.message),
  });

  const canSave = name.trim() !== "" && !addGuestMutation.isPending;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <KeyboardAvoidingView
        className="flex-1 justify-end bg-black/40"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View className={`rounded-t-3xl ${t.screen}`}>
          <View className="px-5 pt-5 pb-8">
            <ModalHeader title="Add Guest" onClose={close} disabled={addGuestMutation.isPending} />

            <Text className={`text-xs mb-5 ${t.textTertiary}`}>
              A guest tracks scores only — no account or app needed. Their scores count
              in team games and on the leaderboard.
            </Text>

            <View className="mb-4">
              <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                Name
              </Text>
              <TextInput
                className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                placeholder="e.g. Uncle Rick"
                placeholderTextColor={t.colors.tabBarInactive}
                value={name}
                onChangeText={setName}
                autoCapitalize="words"
                autoFocus
                editable={!addGuestMutation.isPending}
                returnKeyType="next"
              />
            </View>

            <View className="mb-6">
              <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                Course Handicap (optional)
              </Text>
              <TextInput
                className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                placeholder="Leave blank to play gross"
                placeholderTextColor={t.colors.tabBarInactive}
                value={handicap}
                onChangeText={setHandicap}
                keyboardType="numbers-and-punctuation"
                editable={!addGuestMutation.isPending}
                returnKeyType="done"
                onSubmitEditing={() => canSave && addGuestMutation.mutate()}
              />
            </View>

            <TouchableOpacity
              className={`rounded-xl py-3.5 items-center ${t.primaryBg} ${canSave ? "" : "opacity-60"}`}
              disabled={!canSave}
              onPress={() => addGuestMutation.mutate()}
            >
              {addGuestMutation.isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text className="text-white font-semibold text-base">Add Guest</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
