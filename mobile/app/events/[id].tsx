// app/events/[id].tsx
// Event Detail screen — shown when a user taps an event card in the Events tab.
// This screen is a full-page stack screen (no tab bar) pushed on top of the tabs.
//
// It has three sections:
//   1. Event info   — name, type, status, description, dates, creator
//   2. Members      — roster list; organizers see an "Add Member" button
//   3. Rounds       — scheduled/active/completed rounds; organizers see "Schedule Round"
//
// Tapping a round card navigates to /rounds/[id] (the Round detail/edit screen).
// Organizer actions (edit event, add member, schedule round) open modal sheets.
//
// Auth / permission:
//   - The screen is only reachable by users who are already a member (backend enforces this).
//   - Whether the current user is an organizer is determined client-side by finding their
//     own entry in event.members and checking role === "organizer".

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

// DateInput: auto-formats typed input to MM-DD-YY and shows a native calendar picker.
// apiToDisplay/displayToApi handle YYYY-MM-DD ↔ MM-DD-YY conversion.
import DateInput, { apiToDisplay, displayToApi } from "@/components/DateInput";

// DateTimePicker is the native time picker from @react-native-community/datetimepicker.
// Used in "time" mode for tee time entry in the Schedule Round form.
import DateTimePicker, { DateTimePickerEvent } from "@react-native-community/datetimepicker";

import { useTheme } from "@/hooks/useTheme";
import { EventTypeBadge, StatusChip, RoleBadge, RoundStatusChip } from "@/components/badges";
import SectionHeader from "@/components/SectionHeader";
import ModalHeader from "@/components/ModalHeader";
// UserSummary is exported from UserSearchList so we can type the query data here.
import UserSearchList, { UserSummary } from "@/components/UserSearchList";
// chunk: splits an array into equal-sized sub-arrays — used to render the scoring format
// pill grid as rows without duplicating JSX.
import { chunk } from "@/utils/array";

// ─── Types ────────────────────────────────────────────────────────────────────

type MemberResponse = {
  user_id: string;
  display_name: string;
  email: string;
  role: "organizer" | "player";
  status: string;
  joined_at: string;
};

type EventDetail = {
  id: string;
  name: string;
  description: string | null;
  event_type: "league" | "tournament" | "casual";
  status: string;
  start_date: string | null;
  end_date: string | null;
  creator_name: string;
  member_count: number;
  created_at: string;
  members: MemberResponse[];
};

type RoundSummary = {
  id: string;
  name: string;
  course_name: string;
  scheduled_date: string; // "YYYY-MM-DD"
  status: string;         // "scheduled" | "active" | "completed"
  scoring_format: string;
  round_number: number;
  group_count: number;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const SCORING_FORMATS: { value: string; label: string }[] = [
  { value: "stroke",     label: "Stroke" },
  { value: "net_stroke", label: "Net" },
  { value: "stableford", label: "Stableford" },
  { value: "scramble",   label: "Scramble" },
];

// ─── Tee time helpers ─────────────────────────────────────────────────────────
// Tee times are stored as "HH:MM" (24-hour) strings internally. The native picker
// works with Date objects, so we convert back and forth as needed.

// teeTimeToDate: "HH:MM" → JS Date (today's date, only time matters).
function teeTimeToDate(hhmm: string): Date {
  const d = new Date();
  if (!hhmm) return d;
  const [h, m] = hhmm.split(":").map(Number);
  if (!isNaN(h) && !isNaN(m)) d.setHours(h, m, 0, 0);
  return d;
}

// dateToTeeTime: Date → "HH:MM". padStart ensures single digits are zero-padded (7 → "07").
function dateToTeeTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// formatTeeTime: "HH:MM" → "h:mm AM/PM" for display. e.g. "07:30" → "7:30 AM".
function formatTeeTime(hhmm: string): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return hhmm;
  const ampm = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 || 12; // 0 → 12 (midnight), 12 → 12 (noon)
  return `${hour12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function EventDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { getToken } = useAuth();
  const { user } = useUser();
  const queryClient = useQueryClient();
  const t = useTheme();

  // --- Modal visibility state ---
  const [editModalVisible, setEditModalVisible]                   = useState(false);
  const [addMemberModalVisible, setAddMemberModalVisible]         = useState(false);
  const [scheduleRoundModalVisible, setScheduleRoundModalVisible] = useState(false);

  // --- Edit event form state ---
  const [editName, setEditName]               = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editStartDate, setEditStartDate]     = useState("");
  const [editEndDate, setEditEndDate]         = useState("");

  // --- Add member search state (owned here so it resets when the modal closes) ---
  const [memberSearch, setMemberSearch] = useState("");

  // --- Schedule round form state ---
  const [roundName, setRoundName]         = useState("");
  const [courseName, setCourseName]       = useState("");
  const [roundDate, setRoundDate]         = useState("");
  const [scoringFormat, setScoringFormat] = useState("stroke");
  const [groupCount, setGroupCount]         = useState(1);
  // groupTeeTimes: one "HH:MM" string per group ("" = no tee time set).
  const [groupTeeTimes, setGroupTeeTimes]   = useState<string[]>([""]);
  // openTeeTimePicker: index of the group whose picker is open, or null when closed.
  const [openTeeTimePicker, setOpenTeeTimePicker] = useState<number | null>(null);

  // updateGroupCount resizes groupTeeTimes to match, padding with "" or truncating.
  const updateGroupCount = (n: number) => {
    setGroupCount(n);
    setGroupTeeTimes((prev) => {
      const next = [...prev];
      while (next.length < n) next.push("");
      return next.slice(0, n);
    });
  };

  // --- Queries ---

  const {
    data: event,
    isLoading: eventLoading,
    isError: eventError,
    refetch: refetchEvent,
  } = useQuery<EventDetail>({
    queryKey: ["event", id],
    queryFn: async () => {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/events/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to fetch event: ${res.status}`);
      return res.json();
    },
    enabled: !!id, // Expo Router may render before params are populated
  });

  const {
    data: rounds,
    isLoading: roundsLoading,
  } = useQuery<RoundSummary[]>({
    queryKey: ["event", id, "rounds"],
    queryFn: async () => {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/events/${id}/rounds`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to fetch rounds: ${res.status}`);
      return res.json();
    },
    enabled: !!id,
  });

  const { data: allUsers } = useQuery<UserSummary[]>({
    queryKey: ["users"],
    queryFn: async () => {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/users`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to fetch users");
      return res.json();
    },
    enabled: addMemberModalVisible, // only fetch when the Add Member modal is open
  });

  // --- Derived values ---

  // Match by email — that's what Clerk exposes and what our DB uses as the unique key.
  const myEmail = user?.primaryEmailAddress?.emailAddress;
  const myMembership = event?.members.find((m) => m.email === myEmail);
  const isOrganizer = myMembership?.role === "organizer";

  const existingMemberIds = new Set(event?.members.map((m) => m.user_id) ?? []);
  // Returns undefined while loading — UserSearchList shows a spinner for undefined.
  const availableUsers = allUsers?.filter((u) => !existingMemberIds.has(u.id));

  // --- Mutations ---

  const updateEventMutation = useMutation({
    mutationFn: async (data: {
      name?: string;
      description?: string;
      start_date?: string;
      end_date?: string;
    }) => {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/events/${id}`, {
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
      queryClient.invalidateQueries({ queryKey: ["event", id] });
      queryClient.invalidateQueries({ queryKey: ["events"] });
      setEditModalVisible(false);
    },
    onError: (err: Error) => {
      Alert.alert("Update failed", err.message, [{ text: "OK" }]);
    },
  });

  const addMemberMutation = useMutation({
    mutationFn: async (userId: string) => {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/events/${id}/members`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user_id: userId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["event", id] });
      setAddMemberModalVisible(false);
      setMemberSearch("");
    },
    onError: (err: Error) => {
      Alert.alert("Could not add member", err.message, [{ text: "OK" }]);
    },
  });

  const scheduleRoundMutation = useMutation({
    mutationFn: async (data: {
      name: string;
      course_name: string;
      scheduled_date: string;
      scoring_format: string;
      groups: { tee_time?: string }[];
    }) => {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/events/${id}/rounds`, {
        method: "POST",
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
      queryClient.invalidateQueries({ queryKey: ["event", id, "rounds"] });
      setScheduleRoundModalVisible(false);
      setRoundName("");
      setCourseName("");
      setRoundDate("");
      setScoringFormat("stroke");
      setGroupCount(1);
      setGroupTeeTimes([""]);
    },
    onError: (err: Error) => {
      Alert.alert("Could not schedule round", err.message, [{ text: "OK" }]);
    },
  });

  const cancelEventMutation = useMutation({
    mutationFn: async () => {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/events/${id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["event", id] });
      queryClient.invalidateQueries({ queryKey: ["events"] });
    },
    onError: (err: Error) => {
      Alert.alert("Could not cancel event", err.message, [{ text: "OK" }]);
    },
  });

  const deleteEventMutation = useMutation({
    mutationFn: async () => {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/events/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["events"] });
      router.back();
    },
    onError: (err: Error) => {
      Alert.alert("Could not delete event", err.message, [{ text: "OK" }]);
    },
  });

  // --- Handlers ---

  const openEditModal = () => {
    // Dates from the API are YYYY-MM-DD — convert to MM-DD-YY for DateInput.
    setEditName(event?.name ?? "");
    setEditDescription(event?.description ?? "");
    setEditStartDate(apiToDisplay(event?.start_date));
    setEditEndDate(apiToDisplay(event?.end_date));
    setEditModalVisible(true);
  };

  const handleSaveEdit = () => {
    if (!editName.trim()) {
      Alert.alert("Name required", "Event name cannot be empty.", [{ text: "OK" }]);
      return;
    }
    updateEventMutation.mutate({
      name: editName.trim(),
      description: editDescription,
      start_date: displayToApi(editStartDate.trim()),
      end_date: displayToApi(editEndDate.trim()),
    });
  };

  const handleCancelEvent = () => {
    Alert.alert(
      "Cancel event?",
      "The event will be marked as cancelled. Members will still be able to view it.",
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Cancel Event",
          style: "destructive",
          onPress: () => cancelEventMutation.mutate(),
        },
      ]
    );
  };

  const handleDeleteEvent = () => {
    Alert.alert(
      "Delete event?",
      `"${event?.name}" and all its rounds will be permanently deleted. This cannot be undone.`,
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => deleteEventMutation.mutate(),
        },
      ]
    );
  };

  const handleScheduleRound = () => {
    if (!roundName.trim()) {
      Alert.alert("Name required", "Please enter a name for this round.", [{ text: "OK" }]);
      return;
    }
    if (!courseName.trim()) {
      Alert.alert("Course name required", "Please enter the golf course name.", [{ text: "OK" }]);
      return;
    }
    if (!roundDate.trim()) {
      Alert.alert("Date required", "Please enter the round date (MM-DD-YY).", [{ text: "OK" }]);
      return;
    }
    scheduleRoundMutation.mutate({
      name: roundName.trim(),
      course_name: courseName.trim(),
      scheduled_date: displayToApi(roundDate.trim()),
      scoring_format: scoringFormat,
      // Omit tee_time entirely for blank entries so the backend creates the group with TeeTime = null.
      groups: Array.from({ length: groupCount }, (_, i) => {
        const t = groupTeeTimes[i]?.trim();
        return t ? { tee_time: t } : {};
      }),
    });
  };

  // --- Loading / error states ---

  if (eventLoading) {
    return (
      <View className={`flex-1 ${t.screen} items-center justify-center`}>
        <ActivityIndicator size="large" color={t.colors.tabBarActive} />
      </View>
    );
  }

  if (eventError || !event) {
    return (
      <View className={`flex-1 ${t.screen} items-center justify-center gap-3 px-8`}>
        <Ionicons name="alert-circle-outline" size={48} color="#dc2626" />
        <Text className={`font-semibold text-center ${t.textPrimary}`}>Failed to load event</Text>
        <TouchableOpacity
          className={`${t.primaryBg} rounded-xl px-6 py-3`}
          onPress={() => refetchEvent()}
        >
          <Text className="text-white font-semibold">Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // --- Main render ---
  return (
    <View className={`flex-1 ${t.screen}`}>

      {/* Custom back header — surface color + edit button for organizers */}
      <View className={`${t.surface} border-b ${t.divider} px-4 pt-14 pb-3 flex-row items-center gap-3`}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={t.colors.tabBarActive} />
        </TouchableOpacity>
        <Text className={`text-lg font-bold flex-1 ${t.textPrimary}`} numberOfLines={1}>
          {event.name}
        </Text>
        {isOrganizer && (
          <TouchableOpacity onPress={openEditModal} hitSlop={8}>
            <Ionicons name="pencil-outline" size={20} color="#2563eb" />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView className="flex-1" contentContainerStyle={{ padding: 20 }}>

        {/* ── Event info card ────────────────────────────────────────────────── */}
        <View className={`${t.surface} rounded-2xl p-4 mb-4 border ${t.border}`}>

          <View className="flex-row items-center gap-2 mb-3">
            <EventTypeBadge type={event.event_type} />
            <StatusChip status={event.status} />
          </View>

          {event.description ? (
            <Text className={`text-sm mb-3 leading-5 ${t.textSecondary}`}>{event.description}</Text>
          ) : null}

          {(event.start_date || event.end_date) && (
            <View className="flex-row items-center gap-1 mb-2">
              <Ionicons name="calendar-outline" size={14} color={t.colors.tabBarInactive} />
              <Text className={`text-xs ${t.textTertiary}`}>
                {event.start_date ? apiToDisplay(event.start_date) : "—"}
                {event.end_date ? ` → ${apiToDisplay(event.end_date)}` : ""}
              </Text>
            </View>
          )}

          <View className="flex-row items-center justify-between mt-1">
            <Text className={`text-xs ${t.textTertiary}`}>Created by {event.creator_name}</Text>
            <View className="flex-row items-center gap-1">
              <Ionicons name="people-outline" size={13} color={t.colors.tabBarInactive} />
              <Text className={`text-xs ${t.textTertiary}`}>{event.member_count} members</Text>
            </View>
          </View>

        </View>

        {/* ── Members section ────────────────────────────────────────────────── */}
        <View className="mb-4">
          <SectionHeader
            title={`Members (${event.members.length})`}
            actionLabel="Add Member"
            onAction={() => setAddMemberModalVisible(true)}
            showAction={isOrganizer}
          />

          {event.members.length === 0 ? (
            <Text className={`text-sm text-center py-4 ${t.textTertiary}`}>No members yet.</Text>
          ) : (
            // overflow-hidden clips the border-radius on the first and last rows
            <View className={`${t.surface} rounded-2xl border ${t.border} overflow-hidden`}>
              {event.members.map((member, idx) => (
                <View
                  key={member.user_id}
                  className={`px-4 py-3 flex-row items-center gap-3 ${
                    idx < event.members.length - 1 ? `border-b ${t.divider}` : ""
                  }`}
                >
                  {/* Initials avatar — green-100/green-700 is categorical, not themed */}
                  <View className="w-9 h-9 rounded-full bg-green-100 items-center justify-center flex-shrink-0">
                    <Text className="text-green-700 font-bold text-sm">
                      {member.display_name.charAt(0).toUpperCase()}
                    </Text>
                  </View>

                  {/* min-w-0 prevents text from overflowing the flex container */}
                  <View className="flex-1 min-w-0">
                    <Text className={`font-semibold text-sm ${t.textPrimary}`} numberOfLines={1}>
                      {member.display_name}
                    </Text>
                    <Text className={`text-xs ${t.textTertiary}`} numberOfLines={1}>
                      {member.email}
                    </Text>
                  </View>

                  {/* RoleBadge renders null for "player" — safe to always include */}
                  <RoleBadge role={member.role} />
                </View>
              ))}
            </View>
          )}
        </View>

        {/* ── Rounds section ─────────────────────────────────────────────────── */}
        <View className="mb-8">
          <SectionHeader
            title="Rounds"
            actionLabel="Schedule"
            onAction={() => {
              // Pre-populate with "Round N" where N = current count + 1
              const nextNum = (rounds?.length ?? 0) + 1;
              setRoundName(`Round ${nextNum}`);
              setScheduleRoundModalVisible(true);
            }}
            showAction={isOrganizer}
          />

          {roundsLoading ? (
            <ActivityIndicator color={t.colors.tabBarActive} />
          ) : !rounds || rounds.length === 0 ? (
            <Text className={`text-sm text-center py-4 ${t.textTertiary}`}>
              {isOrganizer
                ? 'Tap "Schedule" to add the first round.'
                : "No rounds scheduled yet."}
            </Text>
          ) : (
            <View className="gap-3">
              {rounds.map((round) => (
                <TouchableOpacity
                  key={round.id}
                  className={`${t.surface} rounded-2xl p-4 border ${t.border}`}
                  onPress={() => router.push(`/rounds/${round.id}`)}
                  activeOpacity={0.7}
                >
                  <View className="flex-row items-center justify-between mb-2">
                    <Text className={`font-bold text-sm ${t.textPrimary}`}>
                      {round.name}
                    </Text>
                    <RoundStatusChip status={round.status} />
                  </View>

                  <View className="flex-row items-center gap-1 mb-1">
                    <Ionicons name="golf-outline" size={13} color={t.colors.tabBarInactive} />
                    <Text className={`text-sm ${t.textSecondary}`}>{round.course_name}</Text>
                  </View>

                  <View className="flex-row items-center justify-between">
                    <View className="flex-row items-center gap-1">
                      <Ionicons name="calendar-outline" size={13} color={t.colors.tabBarInactive} />
                      <Text className={`text-xs ${t.textSecondary}`}>
                        {apiToDisplay(round.scheduled_date)}
                      </Text>
                    </View>
                    <Text className={`text-xs capitalize ${t.textTertiary}`}>
                      {round.scoring_format.replace("_", " ")}
                      {" · "}
                      {round.group_count} {round.group_count === 1 ? "group" : "groups"}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {/* ── Edit Event Modal ───────────────────────────────────────────────── */}

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
                title="Edit Event"
                onClose={() => setEditModalVisible(false)}
                disabled={updateEventMutation.isPending}
              />

              <View className="mb-4">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                  Name <Text className="text-red-500">*</Text>
                </Text>
                <TextInput
                  className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                  placeholderTextColor={t.colors.tabBarInactive}
                  value={editName}
                  onChangeText={setEditName}
                  autoCapitalize="words"
                  editable={!updateEventMutation.isPending}
                  returnKeyType="next"
                />
              </View>

              <View className="mb-4">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                  Description{" "}
                  <Text className={`normal-case font-normal ${t.textTertiary}`}>(optional)</Text>
                </Text>
                <TextInput
                  className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                  placeholderTextColor={t.colors.tabBarInactive}
                  value={editDescription}
                  onChangeText={setEditDescription}
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                  editable={!updateEventMutation.isPending}
                />
              </View>

              <View className="mb-4">
                <DateInput
                  label="Start Date"
                  optional
                  value={editStartDate}
                  onChange={setEditStartDate}
                  disabled={updateEventMutation.isPending}
                  returnKeyType="next"
                />
              </View>

              <View className="mb-8">
                <DateInput
                  label="End Date"
                  optional
                  value={editEndDate}
                  onChange={setEditEndDate}
                  disabled={updateEventMutation.isPending}
                  returnKeyType="done"
                />
              </View>

              <TouchableOpacity
                className={`rounded-xl py-4 items-center ${
                  updateEventMutation.isPending ? t.primaryBgDisabled : t.primaryBg
                }`}
                onPress={handleSaveEdit}
                disabled={updateEventMutation.isPending}
              >
                {updateEventMutation.isPending ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text className="text-white font-semibold text-base">Save Changes</Text>
                )}
              </TouchableOpacity>

              {/* ── Danger zone ──────────────────────────────────────────────────
                  Cancel and Delete are inside the Edit modal so they require a
                  deliberate two-tap gesture, preventing accidental triggers. */}
              <View className={`mt-6 pt-6 border-t ${t.divider} gap-3`}>

                {/* Cancel Event — marks as "cancelled". Greyed out if already cancelled. */}
                <TouchableOpacity
                  className={`rounded-xl py-4 items-center border ${
                    event.status === "cancelled"
                      ? "border-gray-200 bg-gray-50"
                      : "border-amber-200 bg-amber-50"
                  }`}
                  onPress={handleCancelEvent}
                  disabled={
                    cancelEventMutation.isPending ||
                    deleteEventMutation.isPending ||
                    event.status === "cancelled"
                  }
                >
                  {cancelEventMutation.isPending ? (
                    <ActivityIndicator color="#d97706" />
                  ) : (
                    <Text
                      className="text-sm font-semibold"
                      // eslint-disable-next-line react-native/no-inline-styles
                      style={{
                        color: event.status === "cancelled" ? "#9ca3af" : "#d97706",
                      }}
                    >
                      {event.status === "cancelled" ? "Event Cancelled" : "Cancel Event"}
                    </Text>
                  )}
                </TouchableOpacity>

                {/* Delete Event — permanently removes the event and all its data. */}
                <TouchableOpacity
                  className="rounded-xl py-4 items-center bg-red-50 border border-red-200"
                  onPress={handleDeleteEvent}
                  disabled={cancelEventMutation.isPending || deleteEventMutation.isPending}
                >
                  {deleteEventMutation.isPending ? (
                    <ActivityIndicator color="#dc2626" />
                  ) : (
                    <Text className="text-sm font-semibold text-red-600">Delete Event</Text>
                  )}
                </TouchableOpacity>

              </View>

            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Add Member Modal ───────────────────────────────────────────────── */}

      <Modal
        visible={addMemberModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          setAddMemberModalVisible(false);
          setMemberSearch("");
        }}
      >
        <View className={`flex-1 ${t.surface}`}>
          <View className="px-5 pt-8 pb-2">
            <ModalHeader
              title="Add Member"
              onClose={() => {
                setAddMemberModalVisible(false);
                setMemberSearch("");
              }}
            />
          </View>

          {/* UserSearchList owns the search box + list.
              We pass pre-filtered users (non-members only).
              Search state is owned here so it resets when the modal closes. */}
          <View className="flex-1">
            <UserSearchList
              users={availableUsers}
              search={memberSearch}
              onSearchChange={setMemberSearch}
              onSelect={(userId) => addMemberMutation.mutate(userId)}
              isPending={addMemberMutation.isPending}
              emptyMessage="All users are already members of this event."
            />
          </View>
        </View>
      </Modal>

      {/* ── Schedule Round Modal ───────────────────────────────────────────── */}

      <Modal
        visible={scheduleRoundModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          setScheduleRoundModalVisible(false);
          setRoundName("");
          setGroupCount(1);
          setGroupTeeTimes([""]);
          setOpenTeeTimePicker(null);
        }}
      >
        <KeyboardAvoidingView
          className={`flex-1 ${t.surface}`}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView>
            <View className="px-5 pt-8 pb-10">

              <ModalHeader
                title="Schedule Round"
                onClose={() => {
                  setScheduleRoundModalVisible(false);
                  setRoundName("");
                  setGroupCount(1);
                  setGroupTeeTimes([""]);
                }}
                disabled={scheduleRoundMutation.isPending}
              />

              {/* Round name — required; pre-populated with "Round N" but editable */}
              <View className="mb-4">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                  Round Name <Text className="text-red-500">*</Text>
                </Text>
                <TextInput
                  className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                  placeholder="e.g. Round 1"
                  placeholderTextColor={t.colors.tabBarInactive}
                  value={roundName}
                  onChangeText={setRoundName}
                  autoCapitalize="words"
                  editable={!scheduleRoundMutation.isPending}
                  returnKeyType="next"
                />
              </View>

              <View className="mb-4">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                  Course Name <Text className="text-red-500">*</Text>
                </Text>
                <TextInput
                  className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                  placeholder="e.g. Pine Valley Golf Club"
                  placeholderTextColor={t.colors.tabBarInactive}
                  value={courseName}
                  onChangeText={setCourseName}
                  autoCapitalize="words"
                  editable={!scheduleRoundMutation.isPending}
                  returnKeyType="next"
                />
                <Text className={`text-xs mt-1 ml-1 ${t.textTertiary}`}>
                  Existing courses are matched by name — no duplicates created.
                </Text>
              </View>

              <View className="mb-6">
                <DateInput
                  label="Date"
                  required
                  value={roundDate}
                  onChange={setRoundDate}
                  disabled={scheduleRoundMutation.isPending}
                  returnKeyType="done"
                />
              </View>

              {/* Scoring format picker — 2-column pill grid.
                  chunk(SCORING_FORMATS, 2) → [[Stroke, Net], [Stableford, Scramble]] */}
              <View className="mb-8">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                  Scoring Format
                </Text>
                <View className="gap-2">
                  {chunk(SCORING_FORMATS, 2).map((row, rowIdx) => (
                    <View key={rowIdx} className="flex-row gap-2">
                      {row.map((fmt) => {
                        const selected = scoringFormat === fmt.value;
                        return (
                          <TouchableOpacity
                            key={fmt.value}
                            className={`flex-1 rounded-xl py-3 items-center border ${
                              selected
                                ? `${t.primaryBg} border-transparent`
                                : `${t.surface} ${t.borderInput}`
                            }`}
                            onPress={() => setScoringFormat(fmt.value)}
                            disabled={scheduleRoundMutation.isPending}
                          >
                            <Text
                              className={`text-sm font-semibold ${
                                selected ? "text-white" : t.textSecondary
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

              {/* ── Groups ───────────────────────────────────────────────────── */}
              {/* Choose how many tee-time groups to create (1–8) and optionally
                  set a tee time for each. Players are assigned on the Round detail screen. */}
              <View className="mb-8">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-3 ${t.textTertiary}`}>
                  Groups
                </Text>

                {/* +/- stepper */}
                <View className="flex-row items-center gap-3 mb-4">
                  <TouchableOpacity
                    className={`w-10 h-10 rounded-xl border items-center justify-center ${t.borderInput} ${t.surfaceSunken}`}
                    onPress={() => updateGroupCount(Math.max(1, groupCount - 1))}
                    disabled={scheduleRoundMutation.isPending}
                  >
                    <Text className={`text-lg font-bold ${t.textPrimary}`}>–</Text>
                  </TouchableOpacity>

                  <Text className={`text-lg font-bold w-6 text-center ${t.textPrimary}`}>
                    {groupCount}
                  </Text>

                  <TouchableOpacity
                    className={`w-10 h-10 rounded-xl border items-center justify-center ${t.borderInput} ${t.surfaceSunken}`}
                    onPress={() => updateGroupCount(Math.min(8, groupCount + 1))}
                    disabled={scheduleRoundMutation.isPending}
                  >
                    <Text className={`text-lg font-bold ${t.textPrimary}`}>+</Text>
                  </TouchableOpacity>

                  <Text className={`text-sm ${t.textSecondary}`}>
                    {groupCount === 1 ? "group" : "groups"}
                  </Text>
                </View>

                {/* One tee time row per group */}
                <View className="gap-2">
                  {Array.from({ length: groupCount }, (_, i) => (
                    <View key={i} className="flex-row items-center gap-3">
                      <Text className={`text-sm font-semibold w-16 ${t.textSecondary}`}>
                        Group {i + 1}
                      </Text>

                      <TouchableOpacity
                        className={`flex-1 border rounded-xl px-3 py-2 flex-row items-center justify-between ${t.borderInput} ${t.surfaceSunken}`}
                        onPress={() => setOpenTeeTimePicker(i)}
                        disabled={scheduleRoundMutation.isPending}
                        activeOpacity={0.7}
                      >
                        <Text
                          className={`text-sm ${groupTeeTimes[i] ? t.textPrimary : ""}`}
                          // Inline style required for dynamic hex — can't use className on plain Text
                          // eslint-disable-next-line react-native/no-inline-styles
                          style={!groupTeeTimes[i] ? { color: t.colors.tabBarInactive } : undefined}
                        >
                          {groupTeeTimes[i] ? formatTeeTime(groupTeeTimes[i]) : "Set tee time (optional)"}
                        </Text>
                        <Ionicons name="time-outline" size={16} color={t.colors.tabBarInactive} />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>

                {/* Native time picker — Android uses a system dialog; iOS uses a bottom sheet. */}

                {Platform.OS === "android" && openTeeTimePicker !== null && (
                  <DateTimePicker
                    value={teeTimeToDate(groupTeeTimes[openTeeTimePicker] ?? "")}
                    mode="time"
                    display="default"
                    is24Hour={false}
                    onChange={(event: DateTimePickerEvent, date?: Date) => {
                      const idx = openTeeTimePicker;
                      setOpenTeeTimePicker(null);
                      // event.type === "set" means the user confirmed (not cancelled)
                      if (event.type === "set" && date) {
                        const updated = [...groupTeeTimes];
                        updated[idx] = dateToTeeTime(date);
                        setGroupTeeTimes(updated);
                      }
                    }}
                  />
                )}

                {Platform.OS === "ios" && (
                  <Modal
                    visible={openTeeTimePicker !== null}
                    transparent
                    animationType="slide"
                    onRequestClose={() => setOpenTeeTimePicker(null)}
                  >
                    <View className="flex-1">
                      {/* Backdrop — tap to close */}
                      <TouchableOpacity
                        className="absolute inset-0 bg-black/40"
                        activeOpacity={1}
                        onPress={() => setOpenTeeTimePicker(null)}
                      />

                      <View className={`absolute bottom-0 left-0 right-0 ${t.surface} rounded-t-2xl pb-8`}>
                        <View className={`flex-row items-center justify-between px-5 pt-4 pb-2 border-b ${t.divider}`}>
                          <Text className={`font-semibold ${t.textSecondary}`}>
                            {openTeeTimePicker !== null
                              ? `Group ${openTeeTimePicker + 1} Tee Time`
                              : "Tee Time"}
                          </Text>
                          <TouchableOpacity onPress={() => setOpenTeeTimePicker(null)}>
                            {/* "Done" uses theme hex — inline style required for Text color */}
                            <Text
                              className="font-semibold text-base"
                              // eslint-disable-next-line react-native/no-inline-styles
                              style={{ color: t.colors.tabBarActive }}
                            >
                              Done
                            </Text>
                          </TouchableOpacity>
                        </View>

                        {/* Render only when picker is open — also satisfies TypeScript's null check */}
                        {openTeeTimePicker !== null && (
                          <DateTimePicker
                            value={teeTimeToDate(groupTeeTimes[openTeeTimePicker] ?? "")}
                            mode="time"
                            display="spinner"
                            onChange={(_event: DateTimePickerEvent, date?: Date) => {
                              if (date && openTeeTimePicker !== null) {
                                const updated = [...groupTeeTimes];
                                updated[openTeeTimePicker] = dateToTeeTime(date);
                                setGroupTeeTimes(updated);
                              }
                            }}
                            // eslint-disable-next-line react-native/no-inline-styles
                            style={{ height: 200 }}
                          />
                        )}
                      </View>
                    </View>
                  </Modal>
                )}
              </View>

              <TouchableOpacity
                className={`rounded-xl py-4 items-center ${
                  scheduleRoundMutation.isPending ? t.primaryBgDisabled : t.primaryBg
                }`}
                onPress={handleScheduleRound}
                disabled={scheduleRoundMutation.isPending}
              >
                {scheduleRoundMutation.isPending ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text className="text-white font-semibold text-base">Schedule Round</Text>
                )}
              </TouchableOpacity>

            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

    </View>
  );
}
