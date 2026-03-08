// app/rounds/[id].tsx
// Round detail screen — shown when a user taps a round card in the Event detail screen.
// This is a stack screen (no tab bar) at the route /rounds/:id.
//
// It shows:
//   1. Round info    — name, course, date, scoring format, status
//   2. Groups        — each tee-time group with its assigned players (0–4)
//
// Organizer actions (edit icon in header):
//   - Edit Round modal: change name, course, date, or scoring format
//   - Delete Round: confirmation Alert → DELETE /api/v1/rounds/:id → navigate back
//   - Tap "+ Add" on a group to open the "Add Player" modal
//   - Tap a player row to remove them from the group (with confirmation)
//
// Non-organizers can view all groups and players but cannot add, remove, or edit.
//
// Data flow:
//   GET    /api/v1/rounds/:id                               → round detail (includes is_organizer)
//   GET    /api/v1/events/:eventId/members                  → event members for add-player picker
//   PATCH  /api/v1/rounds/:id                               → edit round fields
//   DELETE /api/v1/rounds/:id                               → delete round
//   POST   /api/v1/rounds/:id/groups/:groupId/members       → add player
//   DELETE /api/v1/rounds/:id/groups/:groupId/members/:userId → remove player

import { useState } from "react";
import {
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  Modal,
  TextInput,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";

// useLocalSearchParams reads dynamic route params: /rounds/abc-123 → { id: "abc-123" }
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAuth } from "@clerk/clerk-expo";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Ionicons from "@expo/vector-icons/Ionicons";
import { API_URL } from "@/constants/api";

// apiToDisplay converts "YYYY-MM-DD" → "MM-DD-YY" for display
// displayToApi converts "MM-DD-YY" → "YYYY-MM-DD" for sending to the API
import DateInput, { apiToDisplay, displayToApi } from "@/components/DateInput";

import { useTheme } from "@/hooks/useTheme";
import { RoundStatusChip } from "@/components/badges";
import ModalHeader from "@/components/ModalHeader";
import SectionHeader from "@/components/SectionHeader";
// UserSearchList + UserSummary — reuse the same search+pick component from Add Member flow.
// UserSummary is { id, display_name, email }.
import UserSearchList, { UserSummary } from "@/components/UserSearchList";
// chunk: splits an array into equal-sized sub-arrays — used to render the
// scoring format pill grid as rows. Shared across screens via utils/array.ts.
import { chunk } from "@/utils/array";

// ─── Constants ────────────────────────────────────────────────────────────────

// SCORING_FORMATS: ALL valid scoring formats supported by the backend.
// Displayed as a 2-column pill grid in the Edit Round form.
// Note: this list intentionally differs from events/[id].tsx, which shows only
// a simplified 4-format subset when scheduling a new round. This edit form
// exposes every option so organizers can change to any format after creation.
const SCORING_FORMATS: { value: string; label: string }[] = [
  { value: "stroke",     label: "Stroke" },
  { value: "net_stroke", label: "Net Stroke" },
  { value: "stableford", label: "Stableford" },
  { value: "skins",      label: "Skins" },
  { value: "match_play", label: "Match Play" },
  { value: "scramble",   label: "Scramble" },
  { value: "best_ball",  label: "Best Ball" },
];

// ─── Types ────────────────────────────────────────────────────────────────────

// GroupMember is one player assigned to a group.
type GroupMember = {
  user_id: string;
  round_player_id: string; // used internally; not displayed
  display_name: string;
  email: string;
};

// RoundGroup is one tee-time group with its assigned players.
type RoundGroup = {
  id: string;
  group_number: number;
  tee_time: string | null; // "7:30 AM" formatted by the backend, or null
  starting_hole: number;
  players: GroupMember[];
};

// RoundDetail is the full payload from GET /api/v1/rounds/:id.
type RoundDetail = {
  id: string;
  event_id: string;
  name: string;           // display name, e.g. "Round 1" or "Championship Round"
  course_name: string;
  scheduled_date: string; // "YYYY-MM-DD"
  status: string;         // "scheduled" | "active" | "completed"
  scoring_format: string;
  round_number: number;
  // is_organizer is computed server-side so the client doesn't need an extra permission query.
  is_organizer: boolean;
  groups: RoundGroup[];
};

// EventMember is one row from GET /api/v1/events/:id/members.
type EventMember = {
  user_id: string;
  display_name: string;
  email: string;
  role: "organizer" | "player";
  status: string;
  joined_at: string;
};

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function RoundDetailScreen() {
  // Read the dynamic route segment: /rounds/[id] → params.id
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  // t: active theme — drives all colors on this screen
  const t = useTheme();

  // selectedGroupId: which group's "+ Add" was tapped. null = modal closed.
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  // memberSearch: search text in the Add Player modal (owned here so we can reset on close)
  const [memberSearch, setMemberSearch] = useState("");

  // --- Edit Round modal state ---
  const [editModalVisible, setEditModalVisible]     = useState(false);
  const [editName, setEditName]                     = useState("");
  const [editCourseName, setEditCourseName]         = useState("");
  const [editDate, setEditDate]                     = useState("");         // MM-DD-YY display format
  const [editScoringFormat, setEditScoringFormat]   = useState("stroke");

  // --- Fetch round detail (groups + players + is_organizer) ---
  const {
    data: round,
    isLoading: roundLoading,
    isError: roundError,
    refetch: refetchRound,
  } = useQuery<RoundDetail>({
    queryKey: ["round", id],
    queryFn: async () => {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/rounds/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to fetch round: ${res.status}`);
      return res.json();
    },
    enabled: !!id,
  });

  // --- Fetch event members (for the add-player picker — only when modal is open) ---
  // We need the event_id from the round before we can fetch members.
  const { data: eventMembers } = useQuery<EventMember[]>({
    queryKey: ["event", round?.event_id, "members"],
    queryFn: async () => {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/events/${round!.event_id}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to fetch members");
      return res.json();
    },
    // Only fetch when the add-player modal is open AND we have the event_id.
    // This avoids an unnecessary network request on screen load.
    enabled: !!selectedGroupId && !!round?.event_id,
  });

  // --- Build the available-member list for the add-player picker ---
  // Exclude anyone already assigned to ANY group in this round (a player can only
  // be in one group per round). Map user_id → id to match UserSummary's shape.
  const assignedUserIds = new Set(
    round?.groups.flatMap((g) => g.players.map((p) => p.user_id)) ?? []
  );
  // availableMembers is undefined while eventMembers is loading → UserSearchList shows spinner
  const availableMembers: UserSummary[] | undefined = eventMembers
    ?.filter((m) => !assignedUserIds.has(m.user_id))
    .map((m) => ({ id: m.user_id, display_name: m.display_name, email: m.email }));

  // --- Mutation: add player to group ---
  const addPlayerMutation = useMutation({
    mutationFn: async ({ groupId, userId }: { groupId: string; userId: string }) => {
      const token = await getToken();
      const res = await fetch(
        `${API_URL}/api/v1/rounds/${id}/groups/${groupId}/members`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ user_id: userId }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      // Refresh the round so the new player appears in the group card immediately.
      queryClient.invalidateQueries({ queryKey: ["round", id] });
      setSelectedGroupId(null);
      setMemberSearch("");
    },
    onError: (err: Error) => {
      Alert.alert("Could not add player", err.message, [{ text: "OK" }]);
    },
  });

  // --- Mutation: remove player from group ---
  const removePlayerMutation = useMutation({
    mutationFn: async ({ groupId, userId }: { groupId: string; userId: string }) => {
      const token = await getToken();
      const res = await fetch(
        `${API_URL}/api/v1/rounds/${id}/groups/${groupId}/members/${userId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["round", id] });
    },
    onError: (err: Error) => {
      Alert.alert("Could not remove player", err.message, [{ text: "OK" }]);
    },
  });

  // --- Mutation: update round fields ---
  const updateRoundMutation = useMutation({
    mutationFn: async (data: {
      name?: string;
      course_name?: string;
      scheduled_date?: string; // "YYYY-MM-DD"
      scoring_format?: string;
    }) => {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/rounds/${id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      // Refresh round detail and the parent event's rounds list so the card updates too.
      queryClient.invalidateQueries({ queryKey: ["round", id] });
      if (round?.event_id) {
        queryClient.invalidateQueries({ queryKey: ["event", round.event_id, "rounds"] });
      }
      setEditModalVisible(false);
    },
    onError: (err: Error) => {
      Alert.alert("Could not update round", err.message, [{ text: "OK" }]);
    },
  });

  // --- Mutation: delete round ---
  const deleteRoundMutation = useMutation({
    mutationFn: async () => {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/rounds/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }
    },
    onSuccess: () => {
      // Invalidate the parent event's rounds list so the deleted round disappears there too.
      if (round?.event_id) {
        queryClient.invalidateQueries({ queryKey: ["event", round.event_id, "rounds"] });
      }
      // Navigate back — this round no longer exists.
      router.back();
    },
    onError: (err: Error) => {
      Alert.alert("Could not delete round", err.message, [{ text: "OK" }]);
    },
  });

  // --- Handler: tap a player row to remove them ---
  const handleRemovePlayer = (group: RoundGroup, player: GroupMember) => {
    Alert.alert(
      "Remove player?",
      `Remove ${player.display_name} from Group ${group.group_number}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () =>
            removePlayerMutation.mutate({ groupId: group.id, userId: player.user_id }),
        },
      ]
    );
  };

  // --- Handler: open Edit Round modal pre-filled with current values ---
  const openEditModal = () => {
    if (!round) return;
    setEditName(round.name);
    setEditCourseName(round.course_name);
    // Convert the API's YYYY-MM-DD date to MM-DD-YY for the DateInput component.
    setEditDate(apiToDisplay(round.scheduled_date));
    setEditScoringFormat(round.scoring_format);
    setEditModalVisible(true);
  };

  // --- Handler: save edits ---
  const handleSaveEdit = () => {
    if (!editName.trim()) {
      Alert.alert("Name required", "Round name cannot be empty.", [{ text: "OK" }]);
      return;
    }
    updateRoundMutation.mutate({
      name: editName.trim(),
      course_name: editCourseName.trim() || undefined,
      // Convert MM-DD-YY → YYYY-MM-DD for the API, or undefined if no date was entered.
      scheduled_date: displayToApi(editDate.trim()) || undefined,
      scoring_format: editScoringFormat,
    });
  };

  // --- Handler: delete round with confirmation ---
  const handleDeleteRound = () => {
    Alert.alert(
      "Delete round?",
      `"${round?.name}" and all its group assignments will be permanently deleted.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => deleteRoundMutation.mutate(),
        },
      ]
    );
  };

  // --- Loading / error states ---

  if (roundLoading) {
    return (
      <View className={`flex-1 ${t.screen} items-center justify-center`}>
        <ActivityIndicator size="large" color={t.colors.tabBarActive} />
      </View>
    );
  }

  if (roundError || !round) {
    return (
      <View className={`flex-1 ${t.screen} items-center justify-center gap-3 px-8`}>
        <Ionicons name="alert-circle-outline" size={48} color="#dc2626" />
        <Text className={`font-semibold text-center ${t.textPrimary}`}>
          Failed to load round
        </Text>
        <TouchableOpacity
          className={`${t.primaryBg} rounded-xl px-6 py-3`}
          onPress={() => refetchRound()}
        >
          <Text className="text-white font-semibold">Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // --- Main render ---
  return (
    <View className={`flex-1 ${t.screen}`}>

      {/* ── Custom back header ──────────────────────────────────────────────── */}
      {/* Shows the round name in the title and an edit icon for organizers. */}
      <View
        className={`${t.surface} border-b ${t.divider} px-4 pt-14 pb-3 flex-row items-center gap-3`}
      >
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={t.colors.tabBarActive} />
        </TouchableOpacity>
        <Text className={`text-lg font-bold flex-1 ${t.textPrimary}`} numberOfLines={1}>
          {round.name}
        </Text>
        {/* Edit icon — only visible to organizers. Tapping opens the Edit Round modal. */}
        {round.is_organizer && (
          <TouchableOpacity onPress={openEditModal} hitSlop={8}>
            <Ionicons name="pencil-outline" size={20} color="#2563eb" />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView className="flex-1" contentContainerStyle={{ padding: 20 }}>

        {/* ── Round info card ─────────────────────────────────────────────────── */}
        <View className={`${t.surface} rounded-2xl p-4 mb-6 border ${t.border}`}>

          {/* Status chip — categorical color, not themed */}
          <View className="flex-row items-center gap-2 mb-3">
            <RoundStatusChip status={round.status} />
          </View>

          {/* Course */}
          <View className="flex-row items-center gap-2 mb-2">
            <Ionicons name="golf-outline" size={14} color={t.colors.tabBarInactive} />
            <Text className={`text-sm ${t.textSecondary}`}>{round.course_name}</Text>
          </View>

          {/* Date */}
          <View className="flex-row items-center gap-2 mb-2">
            <Ionicons name="calendar-outline" size={14} color={t.colors.tabBarInactive} />
            <Text className={`text-sm ${t.textSecondary}`}>
              {apiToDisplay(round.scheduled_date)}
            </Text>
          </View>

          {/* Scoring format — capitalize converts "net_stroke" → "Net stroke" */}
          <View className="flex-row items-center gap-2">
            <Ionicons name="podium-outline" size={14} color={t.colors.tabBarInactive} />
            <Text className={`text-sm capitalize ${t.textSecondary}`}>
              {round.scoring_format.replace("_", " ")}
            </Text>
          </View>
        </View>

        {/* ── Groups section ──────────────────────────────────────────────────── */}
        {/* SectionHeader shows the count; showAction is false — group "+" buttons are per-group */}
        <SectionHeader
          title={`Groups (${round.groups.length})`}
          actionLabel=""
          onAction={() => {}}
          showAction={false}
        />

        <View className="gap-4 mb-8">
          {round.groups.map((group) => (
            <View
              key={group.id}
              className={`${t.surface} rounded-2xl border ${t.border} overflow-hidden`}
            >
              {/* Group header row: group number + optional tee time */}
              <View className={`px-4 py-3 flex-row items-center justify-between border-b ${t.divider}`}>
                <Text className={`font-bold text-base ${t.textPrimary}`}>
                  Group {group.group_number}
                </Text>
                {group.tee_time ? (
                  <View className="flex-row items-center gap-1">
                    <Ionicons name="time-outline" size={13} color={t.colors.tabBarInactive} />
                    <Text className={`text-sm ${t.textSecondary}`}>{group.tee_time}</Text>
                  </View>
                ) : null}
              </View>

              {/* Player slots — always show 4 rows; empty slots shown as dashes */}
              {Array.from({ length: 4 }, (_, slotIdx) => {
                const player = group.players[slotIdx];
                return (
                  <View
                    key={slotIdx}
                    className={`px-4 py-3 flex-row items-center gap-3 ${
                      // Divider between every row except the last
                      slotIdx < 3 ? `border-b ${t.divider}` : ""
                    }`}
                  >
                    {player ? (
                      // Assigned player row — tappable to remove (organizers only)
                      round.is_organizer ? (
                        <TouchableOpacity
                          className="flex-1 flex-row items-center gap-3"
                          onPress={() => handleRemovePlayer(group, player)}
                          activeOpacity={0.7}
                          disabled={removePlayerMutation.isPending}
                        >
                          {/* Initials avatar — green-100/green-700 is categorical, not themed */}
                          <View className="w-8 h-8 rounded-full bg-green-100 items-center justify-center flex-shrink-0">
                            <Text className="text-green-700 font-bold text-xs">
                              {player.display_name.charAt(0).toUpperCase()}
                            </Text>
                          </View>
                          <View className="flex-1 min-w-0">
                            <Text
                              className={`font-semibold text-sm ${t.textPrimary}`}
                              numberOfLines={1}
                            >
                              {player.display_name}
                            </Text>
                            <Text className={`text-xs ${t.textTertiary}`} numberOfLines={1}>
                              {player.email}
                            </Text>
                          </View>
                          {/* Trash icon hint — visible so user knows the row is tappable */}
                          <Ionicons
                            name="close-circle-outline"
                            size={18}
                            color={t.colors.tabBarInactive}
                          />
                        </TouchableOpacity>
                      ) : (
                        // Non-organizers see the player row but it isn't tappable
                        <View className="flex-1 flex-row items-center gap-3">
                          <View className="w-8 h-8 rounded-full bg-green-100 items-center justify-center flex-shrink-0">
                            <Text className="text-green-700 font-bold text-xs">
                              {player.display_name.charAt(0).toUpperCase()}
                            </Text>
                          </View>
                          <View className="flex-1 min-w-0">
                            <Text
                              className={`font-semibold text-sm ${t.textPrimary}`}
                              numberOfLines={1}
                            >
                              {player.display_name}
                            </Text>
                            <Text className={`text-xs ${t.textTertiary}`} numberOfLines={1}>
                              {player.email}
                            </Text>
                          </View>
                        </View>
                      )
                    ) : (
                      // Empty slot — show a dash placeholder
                      <Text className={`text-sm italic ${t.textTertiary}`}>
                        — empty slot
                      </Text>
                    )}
                  </View>
                );
              })}

              {/* "+ Add" button — shown only to organizers when the group has fewer than 4 players */}
              {round.is_organizer && group.players.length < 4 && (
                <TouchableOpacity
                  className={`px-4 py-3 flex-row items-center gap-2 border-t ${t.divider}`}
                  onPress={() => setSelectedGroupId(group.id)}
                  activeOpacity={0.7}
                >
                  <Ionicons name="person-add-outline" size={16} color={t.colors.tabBarActive} />
                  <Text
                    // eslint-disable-next-line react-native/no-inline-styles
                    style={{ color: t.colors.tabBarActive }}
                    className="text-sm font-semibold"
                  >
                    Add Player
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </View>

      </ScrollView>

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* ── Edit Round Modal ────────────────────────────────────────────────── */}
      {/* Opens when the organizer taps the pencil icon in the header. */}
      {/* ══════════════════════════════════════════════════════════════════════ */}

      <Modal
        visible={editModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setEditModalVisible(false)}
      >
        <KeyboardAvoidingView
          className={`flex-1 ${t.surface}`}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView>
            <View className="px-5 pt-8 pb-10">

              <ModalHeader
                title="Edit Round"
                onClose={() => setEditModalVisible(false)}
                disabled={updateRoundMutation.isPending || deleteRoundMutation.isPending}
              />

              {/* Round name — required; cannot be saved as empty */}
              <View className="mb-4">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                  Round Name <Text className="text-red-500">*</Text>
                </Text>
                <TextInput
                  className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                  placeholder="e.g. Round 1"
                  placeholderTextColor={t.colors.tabBarInactive}
                  value={editName}
                  onChangeText={setEditName}
                  autoCapitalize="words"
                  editable={!updateRoundMutation.isPending}
                  returnKeyType="next"
                />
              </View>

              {/* Course name — optional to change; blank = keep current course */}
              <View className="mb-4">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                  Course Name
                </Text>
                <TextInput
                  className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                  placeholder="e.g. Pine Valley Golf Club"
                  placeholderTextColor={t.colors.tabBarInactive}
                  value={editCourseName}
                  onChangeText={setEditCourseName}
                  autoCapitalize="words"
                  editable={!updateRoundMutation.isPending}
                  returnKeyType="next"
                />
              </View>

              {/* Date — uses DateInput for auto-formatting + native picker */}
              <View className="mb-6">
                <DateInput
                  label="Date"
                  value={editDate}
                  onChange={setEditDate}
                  disabled={updateRoundMutation.isPending}
                  returnKeyType="done"
                />
              </View>

              {/* Scoring format — 2-column pill grid matching the Schedule Round form */}
              <View className="mb-8">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-3 ${t.textTertiary}`}>
                  Scoring Format
                </Text>
                <View className="gap-2">
                  {chunk(SCORING_FORMATS, 2).map((row, rowIdx) => (
                    <View key={rowIdx} className="flex-row gap-2">
                      {row.map((fmt) => {
                        // isSelected: true if this pill is the active scoring format
                        const isSelected = editScoringFormat === fmt.value;
                        return (
                          <TouchableOpacity
                            key={fmt.value}
                            className={`flex-1 py-2 rounded-xl border items-center ${
                              isSelected
                                ? "bg-green-700 border-green-700"
                                : `${t.surfaceSunken} ${t.borderInput}`
                            }`}
                            onPress={() => setEditScoringFormat(fmt.value)}
                            disabled={updateRoundMutation.isPending}
                          >
                            <Text
                              className={`text-sm font-semibold ${
                                isSelected ? "text-white" : t.textSecondary
                              }`}
                            >
                              {fmt.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  ))}
                </View>
              </View>

              {/* Save button */}
              <TouchableOpacity
                className={`rounded-xl py-4 items-center mb-4 ${
                  updateRoundMutation.isPending ? t.primaryBgDisabled : t.primaryBg
                }`}
                onPress={handleSaveEdit}
                disabled={updateRoundMutation.isPending || deleteRoundMutation.isPending}
              >
                {updateRoundMutation.isPending ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text className="text-white font-semibold text-base">Save Changes</Text>
                )}
              </TouchableOpacity>

              {/* Delete Round — destructive action at the bottom of the modal.
                  Uses categorical red (not a theme token) because this is a brand-specific
                  danger color, not a UI surface color. */}
              <TouchableOpacity
                className="rounded-xl py-4 items-center border border-red-200 bg-red-50"
                onPress={handleDeleteRound}
                disabled={updateRoundMutation.isPending || deleteRoundMutation.isPending}
              >
                {deleteRoundMutation.isPending ? (
                  <ActivityIndicator color="#dc2626" />
                ) : (
                  <Text className="text-red-600 font-semibold text-base">Delete Round</Text>
                )}
              </TouchableOpacity>

            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* ── Add Player Modal ────────────────────────────────────────────────── */}
      {/* Opens when the user taps "+ Add Player" on a group card. */}
      {/* ══════════════════════════════════════════════════════════════════════ */}

      <Modal
        visible={!!selectedGroupId}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          setSelectedGroupId(null);
          setMemberSearch("");
        }}
      >
        <View className={`flex-1 ${t.surface}`}>

          <View className="px-5 pt-8 pb-2">
            <ModalHeader
              title="Add Player"
              onClose={() => {
                setSelectedGroupId(null);
                setMemberSearch("");
              }}
              disabled={addPlayerMutation.isPending}
            />
          </View>

          {/* UserSearchList handles the search box, loading state, and item list.
              availableMembers is undefined while loading → shows a spinner.
              We filter out already-assigned members before passing the list. */}
          <View className="flex-1">
            <UserSearchList
              users={availableMembers}
              search={memberSearch}
              onSearchChange={setMemberSearch}
              onSelect={(userId) => {
                if (selectedGroupId) {
                  addPlayerMutation.mutate({ groupId: selectedGroupId, userId });
                }
              }}
              isPending={addPlayerMutation.isPending}
              emptyMessage="All event members are already assigned to a group."
            />
          </View>

        </View>
      </Modal>

    </View>
  );
}
