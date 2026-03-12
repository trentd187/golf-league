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
//   GET    /api/v1/rounds/:id                                 → round detail (includes is_organizer)
//   GET    /api/v1/events/:eventId/members                    → event members for add-player picker
//   PATCH  /api/v1/rounds/:id                                 → edit round fields
//   DELETE /api/v1/rounds/:id                                 → delete round
//   POST   /api/v1/rounds/:id/groups/:groupId/members         → add player
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

import { useLocalSearchParams, useRouter } from "expo-router";
import { useAuth, useUser } from "@clerk/clerk-expo";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Ionicons from "@expo/vector-icons/Ionicons";
import { API_URL } from "@/constants/api";
import DateInput, { apiToDisplay, displayToApi } from "@/components/DateInput";
import { useTheme } from "@/hooks/useTheme";
import { RoundStatusChip } from "@/components/badges";
import ModalHeader from "@/components/ModalHeader";
import SectionHeader from "@/components/SectionHeader";
import UserSearchList, { UserSummary } from "@/components/UserSearchList";
// chunk: splits an array into equal-sized sub-arrays — used to render the scoring
// format pill grid as rows without duplicating JSX.
import { chunk } from "@/utils/array";
import CoursePickerModal, { PickedCourse } from "@/components/CoursePickerModal";
import { SCORING_FORMATS, formatLabel } from "@/utils/scoringFormats";

// ─── Types ────────────────────────────────────────────────────────────────────

type GroupMember = {
  user_id: string;
  round_player_id: string;
  display_name: string;
  email: string;
};

type RoundGroup = {
  id: string;
  group_number: number;
  tee_time: string | null; // "7:30 AM" formatted by the backend, or null
  starting_hole: number;
  players: GroupMember[];
};

type RoundDetail = {
  id: string;
  event_id: string;
  name: string;
  course_name: string;
  scheduled_date: string; // "YYYY-MM-DD"
  status: string;         // "scheduled" | "active" | "completed"
  scoring_format: string;
  round_number: number;
  // is_organizer is computed server-side so the client doesn't need a separate permission query.
  is_organizer: boolean;
  groups: RoundGroup[];
};

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
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { getToken } = useAuth();
  const { user } = useUser();
  const queryClient = useQueryClient();
  const t = useTheme();

  // selectedGroupId: which group's "+ Add Player" was tapped; null = modal closed.
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  // memberSearch: owned here so it resets when the modal closes.
  const [memberSearch, setMemberSearch] = useState("");

  const [editModalVisible, setEditModalVisible]       = useState(false);
  const [editName, setEditName]                       = useState("");
  const [editDate, setEditDate]                       = useState(""); // MM-DD-YY display format
  const [editScoringFormat, setEditScoringFormat]     = useState("stroke");
  // editNewCourse: set only if the user picks a different course via CoursePickerModal.
  // Null means "don't change the course" — the PATCH body won't include course fields.
  const [editNewCourse, setEditNewCourse]             = useState<PickedCourse | null>(null);
  const [editNewTeeId, setEditNewTeeId]               = useState<string | null>(null);
  const [coursePickerVisible, setCoursePickerVisible] = useState(false);

  // --- Queries ---

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
    // Only fetch when the Add Player modal is open and we have the event_id.
    enabled: !!selectedGroupId && !!round?.event_id,
  });

  // --- Derived values ---

  // Exclude anyone already assigned to ANY group — a player can only be in one group per round.
  const assignedUserIds = new Set(
    round?.groups.flatMap((g) => g.players.map((p) => p.user_id)) ?? []
  );
  // Returns undefined while loading — UserSearchList shows a spinner for undefined.
  const availableMembers: UserSummary[] | undefined = eventMembers
    ?.filter((m) => !assignedUserIds.has(m.user_id))
    .map((m) => ({ id: m.user_id, display_name: m.display_name, email: m.email }));

  // --- Mutations ---

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
      queryClient.invalidateQueries({ queryKey: ["round", id] });
      setSelectedGroupId(null);
      setMemberSearch("");
    },
    onError: (err: Error) => {
      Alert.alert("Could not add player", err.message, [{ text: "OK" }]);
    },
  });

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

  const updateRoundMutation = useMutation({
    mutationFn: async (data: {
      name?: string;
      scheduled_date?: string;
      scoring_format?: string;
      // Preferred: explicit UUIDs when the user selects a course with managed tees.
      course_id?: string;
      default_tee_id?: string;
      // Legacy fallback: by name when the course has no tees.
      course_name?: string;
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
      if (round?.event_id) {
        queryClient.invalidateQueries({ queryKey: ["event", round.event_id, "rounds"] });
      }
      router.back();
    },
    onError: (err: Error) => {
      Alert.alert("Could not delete round", err.message, [{ text: "OK" }]);
    },
  });

  // startRoundMutation advances the round status from "scheduled" → "active".
  // Only shown to organizers when the round hasn't started yet.
  const startRoundMutation = useMutation({
    mutationFn: async () => {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/rounds/${id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["round", id] });
      // Navigate to the scorecard for the organizer's group (if they're assigned to one),
      // otherwise fall back to the first group that has players.
      const userId = user?.id;
      const myGroup = round?.groups.find((g) =>
        g.players.some((p) => p.user_id === userId)
      );
      const targetGroup = myGroup ?? round?.groups.find((g) => g.players.length > 0);
      if (targetGroup) {
        router.push(
          `/scorecard/${id}?groupId=${targetGroup.id}&groupNumber=${targetGroup.group_number}`
        );
      }
    },
    onError: (err: Error) => {
      Alert.alert("Could not start round", err.message, [{ text: "OK" }]);
    },
  });

  // --- Handlers ---

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

  const openEditModal = () => {
    if (!round) return;
    setEditName(round.name);
    setEditDate(apiToDisplay(round.scheduled_date));
    setEditScoringFormat(round.scoring_format);
    // Reset course change state — user must explicitly pick a new course to change it.
    setEditNewCourse(null);
    setEditNewTeeId(null);
    setEditModalVisible(true);
  };

  const handleSaveEdit = () => {
    if (!editName.trim()) {
      Alert.alert("Name required", "Round name cannot be empty.", [{ text: "OK" }]);
      return;
    }
    if (editNewCourse && editNewCourse.tees.length > 0 && !editNewTeeId) {
      Alert.alert("Tee required", "Please select a tee set for the new course.", [{ text: "OK" }]);
      return;
    }

    // Build course portion of the payload — only included when the user changed the course.
    let coursePatch: {
      course_id?: string;
      default_tee_id?: string;
      course_name?: string;
    } = {};

    if (editNewCourse) {
      if (editNewTeeId) {
        coursePatch = { course_id: editNewCourse.id, default_tee_id: editNewTeeId };
      } else {
        // Course has no tees — use legacy name path so the backend attaches a default tee.
        coursePatch = { course_name: editNewCourse.name };
      }
    }

    updateRoundMutation.mutate({
      name: editName.trim(),
      ...coursePatch,
      scheduled_date: displayToApi(editDate.trim()) || undefined,
      scoring_format: editScoringFormat,
    });
  };

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

      {/* Custom back header — shows round name and edit icon for organizers */}
      <View
        className={`${t.surface} border-b ${t.divider} px-4 pt-14 pb-3 flex-row items-center gap-3`}
      >
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={t.colors.tabBarActive} />
        </TouchableOpacity>
        <Text className={`text-lg font-bold flex-1 ${t.textPrimary}`} numberOfLines={1}>
          {round.name}
        </Text>
        {round.is_organizer && (
          <TouchableOpacity onPress={openEditModal} hitSlop={8}>
            <Ionicons name="pencil-outline" size={20} color="#2563eb" />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView className="flex-1" contentContainerStyle={{ padding: 20 }}>

        {/* ── Round info card ─────────────────────────────────────────────────── */}
        <View className={`${t.surface} rounded-2xl p-4 mb-6 border ${t.border}`}>

          <View className="flex-row items-center gap-2 mb-3">
            <RoundStatusChip status={round.status} />
          </View>

          <View className="flex-row items-center gap-2 mb-2">
            <Ionicons name="golf-outline" size={14} color={t.colors.tabBarInactive} />
            <Text className={`text-sm ${t.textSecondary}`}>{round.course_name}</Text>
          </View>

          <View className="flex-row items-center gap-2 mb-2">
            <Ionicons name="calendar-outline" size={14} color={t.colors.tabBarInactive} />
            <Text className={`text-sm ${t.textSecondary}`}>
              {apiToDisplay(round.scheduled_date)}
            </Text>
          </View>

          {/* capitalize converts "net_stroke" → "Net stroke" */}
          <View className="flex-row items-center gap-2">
            <Ionicons name="podium-outline" size={14} color={t.colors.tabBarInactive} />
            <Text className={`text-sm ${t.textSecondary}`}>
              {formatLabel(round.scoring_format)}
            </Text>
          </View>

          {/* Start Round button — organizer only, only when round is still scheduled */}
          {round.is_organizer && round.status === "scheduled" && (
            <TouchableOpacity
              className={`mt-3 flex-row items-center justify-center gap-2 rounded-xl py-2.5 ${
                startRoundMutation.isPending ? "bg-green-700/40" : "bg-green-700"
              }`}
              onPress={() => startRoundMutation.mutate()}
              disabled={startRoundMutation.isPending}
              activeOpacity={0.8}
            >
              {startRoundMutation.isPending ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <>
                  <Ionicons name="play-circle-outline" size={16} color="white" />
                  <Text className="text-white font-semibold text-sm">Start Round</Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>

        {/* ── Groups section ──────────────────────────────────────────────────── */}
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
              {/* Group header: number + optional tee time */}
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

              {/* Always render 4 player slots; empty slots show a dash */}
              {Array.from({ length: 4 }, (_, slotIdx) => {
                const player = group.players[slotIdx];
                return (
                  <View
                    key={slotIdx}
                    className={`px-4 py-3 flex-row items-center gap-3 ${
                      slotIdx < 3 ? `border-b ${t.divider}` : ""
                    }`}
                  >
                    {player ? (
                      round.is_organizer ? (
                        // Organizer: player row is tappable to remove
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
                          <Ionicons
                            name="close-circle-outline"
                            size={18}
                            color={t.colors.tabBarInactive}
                          />
                        </TouchableOpacity>
                      ) : (
                        // Non-organizer: player row is read-only
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
                      <Text className={`text-sm italic ${t.textTertiary}`}>
                        — empty slot
                      </Text>
                    )}
                  </View>
                );
              })}

              {/* "+ Add Player" — only for organizers when the group has fewer than 4 players */}
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

              {/* Scorecard — shown when the group has at least one player */}
              {group.players.length > 0 && (
                <TouchableOpacity
                  className={`px-4 py-3 flex-row items-center gap-2 border-t ${t.divider}`}
                  onPress={() =>
                    router.push(
                      `/scorecard/${id}?groupId=${group.id}&groupNumber=${group.group_number}`
                    )
                  }
                  activeOpacity={0.7}
                >
                  <Ionicons name="list-outline" size={16} color={t.colors.tabBarActive} />
                  <Text
                    // eslint-disable-next-line react-native/no-inline-styles
                    style={{ color: t.colors.tabBarActive }}
                    className="text-sm font-semibold"
                  >
                    Scorecard
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </View>

      </ScrollView>

      {/* ── Edit Round Modal ────────────────────────────────────────────────── */}

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

              {/* Course section — shows current course, allows changing via picker */}
              <View className="mb-4">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                  Course
                </Text>

                {/* Display-only chip showing the active course name */}
                <View className={`flex-row items-center border rounded-xl px-4 py-3 mb-2 ${t.border}`}>
                  <Ionicons name="golf-outline" size={14} color={t.colors.tabBarInactive} style={{ marginRight: 8 }} />
                  <Text className={`flex-1 text-sm ${t.textSecondary}`} numberOfLines={1}>
                    {editNewCourse ? editNewCourse.name : round.course_name}
                  </Text>
                  {editNewCourse && (
                    <TouchableOpacity
                      onPress={() => { setEditNewCourse(null); setEditNewTeeId(null); }}
                      hitSlop={8}
                      disabled={updateRoundMutation.isPending}
                    >
                      <Ionicons name="close-circle" size={16} color={t.colors.tabBarInactive} />
                    </TouchableOpacity>
                  )}
                </View>

                {/* Button to open the course picker */}
                <TouchableOpacity
                  className={`flex-row items-center justify-center gap-2 border rounded-xl py-2.5 ${t.borderInput}`}
                  onPress={() => setCoursePickerVisible(true)}
                  disabled={updateRoundMutation.isPending}
                  activeOpacity={0.7}
                >
                  <Ionicons name="search-outline" size={15} color={t.colors.tabBarActive} />
                  {/* eslint-disable-next-line react-native/no-inline-styles */}
                  <Text className="text-sm font-semibold" style={{ color: t.colors.tabBarActive }}>
                    {editNewCourse ? "Change Course" : "Change Course"}
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Tee picker — only shown when user has picked a new course that has tees */}
              {editNewCourse && editNewCourse.tees.length > 0 && (
                <View className="mb-4">
                  <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                    Tee <Text className="text-red-500">*</Text>
                  </Text>
                  <View className="gap-2">
                    {chunk(editNewCourse.tees, 2).map((row, rowIdx) => (
                      <View key={rowIdx} className="flex-row gap-2">
                        {row.map((tee) => {
                          const selected = editNewTeeId === tee.id;
                          return (
                            <TouchableOpacity
                              key={tee.id}
                              className={`flex-1 rounded-xl py-2.5 px-2 items-center border ${
                                selected ? "bg-green-700 border-green-700" : `${t.surfaceSunken} ${t.borderInput}`
                              }`}
                              onPress={() => setEditNewTeeId(tee.id)}
                              disabled={updateRoundMutation.isPending}
                            >
                              <Text className={`text-sm font-semibold ${selected ? "text-white" : t.textSecondary}`}>
                                {tee.name}
                              </Text>
                              <Text className={`text-xs mt-0.5 ${selected ? "text-white/80" : t.textTertiary}`}>
                                Par {tee.par} · Slope {tee.slope_rating} · {tee.course_rating}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    ))}
                  </View>
                </View>
              )}

              {/* Info chip when new course has no tees */}
              {editNewCourse && editNewCourse.tees.length === 0 && (
                <View className={`mb-4 flex-row items-center gap-2 rounded-xl px-3 py-2.5 border ${t.border}`}>
                  <Ionicons name="information-circle-outline" size={16} color={t.colors.tabBarInactive} />
                  <Text className={`text-xs flex-1 ${t.textTertiary}`}>
                    No tees configured — a default tee will be created automatically.
                  </Text>
                </View>
              )}

              <View className="mb-6">
                <DateInput
                  label="Date"
                  value={editDate}
                  onChange={setEditDate}
                  disabled={updateRoundMutation.isPending}
                  returnKeyType="done"
                />
              </View>

              {/* Scoring format — 2-column pill grid */}
              <View className="mb-8">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-3 ${t.textTertiary}`}>
                  Scoring Format
                </Text>
                <View className="gap-2">
                  {chunk(SCORING_FORMATS, 2).map((row, rowIdx) => (
                    <View key={rowIdx} className="flex-row gap-2">
                      {row.map((fmt) => {
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

              {/* Delete Round — always red, not themed */}
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

      {/* ── Add Player Modal ────────────────────────────────────────────────── */}

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

          {/* availableMembers is undefined while loading — UserSearchList shows a spinner. */}
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

      {/* ── Course Picker Modal ─────────────────────────────────────────────── */}
      <CoursePickerModal
        visible={coursePickerVisible}
        onClose={() => setCoursePickerVisible(false)}
        onSelect={(course) => {
          setEditNewCourse(course);
          setEditNewTeeId(null);
          setCoursePickerVisible(false);
        }}
      />

    </View>
  );
}
