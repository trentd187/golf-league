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
//
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

// useLocalSearchParams: reads dynamic route params from the URL.
// For the route /events/abc-123, { id } = useLocalSearchParams() → id = "abc-123"
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAuth, useUser } from "@clerk/clerk-expo";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Ionicons from "@expo/vector-icons/Ionicons";
import { API_URL } from "@/constants/api";

// DateInput: our custom date field that supports both typed input (auto-formatted to MM-DD-YY)
// and a native calendar picker. apiToDisplay/displayToApi handle format conversion.
import DateInput, { apiToDisplay, displayToApi } from "@/components/DateInput";

// useTheme gives us the active theme's class strings and hex colors.
import { useTheme } from "@/hooks/useTheme";

// Shared UI components — imported from components/ so the Round detail screen
// can reuse the same atoms without duplication. See CLAUDE.md for the convention.
import { EventTypeBadge, StatusChip, RoleBadge, RoundStatusChip } from "@/components/badges";
import SectionHeader from "@/components/SectionHeader";
import ModalHeader from "@/components/ModalHeader";
// UserSummary is the type for a user summary from GET /api/v1/users.
// It's exported from UserSearchList so we can type the query data here.
import UserSearchList, { UserSummary } from "@/components/UserSearchList";

// ─── Types ────────────────────────────────────────────────────────────────────
// These match the backend response shapes for the event detail and rounds endpoints.

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
  course_name: string;
  scheduled_date: string; // "YYYY-MM-DD"
  status: string;         // "scheduled" | "active" | "completed"
  scoring_format: string;
  round_number: number;
};

// ─── Constants ────────────────────────────────────────────────────────────────

// SCORING_FORMATS: the four ways scores can be tallied in a round.
// Rendered as a 2-column pill grid in the Schedule Round form.
const SCORING_FORMATS: { value: string; label: string }[] = [
  { value: "stroke",     label: "Stroke" },
  { value: "net_stroke", label: "Net" },
  { value: "stableford", label: "Stableford" },
  { value: "scramble",   label: "Scramble" },
];

// chunk: splits an array into sub-arrays of `size` length.
// Used to render SCORING_FORMATS as two rows of two pills each,
// without duplicating the pill JSX.
// Example: chunk([a, b, c, d], 2) → [[a, b], [c, d]]
function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function EventDetailScreen() {
  // Read the dynamic segment from the URL: /events/[id] → params.id
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { getToken } = useAuth();
  const { user } = useUser();
  const queryClient = useQueryClient();

  // t: the active theme — drives background, surface, and text colors throughout this screen.
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
  const [courseName, setCourseName]       = useState("");
  const [roundDate, setRoundDate]         = useState("");
  const [scoringFormat, setScoringFormat] = useState("stroke");

  // --- Fetch event detail (includes members list) ---
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
    enabled: !!id, // only run when id is available (Expo Router may render before params are set)
  });

  // --- Fetch rounds for this event ---
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

  // --- Fetch all users (for Add Member picker — only when modal is open) ---
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
    // Only fetch when the modal is open — avoids an unnecessary API call on screen load.
    enabled: addMemberModalVisible,
  });

  // --- Determine if the current user is an organizer ---
  // We match by email because that's what Clerk exposes and what our DB uses as the unique key.
  const myEmail = user?.primaryEmailAddress?.emailAddress;
  const myMembership = event?.members.find((m) => m.email === myEmail);
  const isOrganizer = myMembership?.role === "organizer";

  // --- Filter users for the Add Member picker ---
  // Exclude users who are already members of this event.
  // UserSearchList will further filter by the search text the user types.
  const existingMemberIds = new Set(event?.members.map((m) => m.user_id) ?? []);
  // allUsers?.filter(...) returns undefined while allUsers is still loading — that's
  // intentional: UserSearchList shows a spinner when it receives undefined.
  const availableUsers = allUsers?.filter((u) => !existingMemberIds.has(u.id));

  // --- Mutation: update event ---
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
      // Invalidate both the detail query and the events list so everything stays in sync.
      queryClient.invalidateQueries({ queryKey: ["event", id] });
      queryClient.invalidateQueries({ queryKey: ["events"] });
      setEditModalVisible(false);
    },
    onError: (err: Error) => {
      Alert.alert("Update failed", err.message, [{ text: "OK" }]);
    },
  });

  // --- Mutation: add member ---
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

  // --- Mutation: schedule round ---
  const scheduleRoundMutation = useMutation({
    mutationFn: async (data: {
      course_name: string;
      scheduled_date: string;
      scoring_format: string;
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
      setCourseName("");
      setRoundDate("");
      setScoringFormat("stroke");
    },
    onError: (err: Error) => {
      Alert.alert("Could not schedule round", err.message, [{ text: "OK" }]);
    },
  });

  // --- Handlers ---

  const openEditModal = () => {
    // Pre-fill the form with current values.
    // Dates come from the API as YYYY-MM-DD — convert to MM-DD-YY for the DateInput.
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
    // Convert dates from MM-DD-YY display format back to YYYY-MM-DD for the API.
    // displayToApi returns "" for empty input — the backend treats "" as "clear the field".
    updateEventMutation.mutate({
      name: editName.trim(),
      description: editDescription,
      start_date: displayToApi(editStartDate.trim()),
      end_date: displayToApi(editEndDate.trim()),
    });
  };

  const handleScheduleRound = () => {
    if (!courseName.trim()) {
      Alert.alert("Course name required", "Please enter the golf course name.", [{ text: "OK" }]);
      return;
    }
    if (!roundDate.trim()) {
      Alert.alert("Date required", "Please enter the round date (MM-DD-YY).", [{ text: "OK" }]);
      return;
    }
    scheduleRoundMutation.mutate({
      course_name: courseName.trim(),
      // Convert MM-DD-YY → YYYY-MM-DD before sending to the backend
      scheduled_date: displayToApi(roundDate.trim()),
      scoring_format: scoringFormat,
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
    // t.screen: full-page background color
    <View className={`flex-1 ${t.screen}`}>

      {/* ── Custom back header ─────────────────────────────────────────────── */}
      {/* We use a custom header instead of the default Stack header so we can
          control its exact appearance (surface color, divider, edit button). */}
      <View className={`${t.surface} border-b ${t.divider} px-4 pt-14 pb-3 flex-row items-center gap-3`}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={t.colors.tabBarActive} />
        </TouchableOpacity>
        <Text className={`text-lg font-bold flex-1 ${t.textPrimary}`} numberOfLines={1}>
          {event.name}
        </Text>
        {/* Edit button — only shown to organizers */}
        {isOrganizer && (
          <TouchableOpacity onPress={openEditModal} hitSlop={8}>
            <Ionicons name="pencil-outline" size={20} color="#2563eb" />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView className="flex-1" contentContainerStyle={{ padding: 20 }}>

        {/* ── Event info card ────────────────────────────────────────────────── */}
        <View className={`${t.surface} rounded-2xl p-4 mb-4 border ${t.border}`}>

          {/* Type badge + status chip — both use categorical colors, not theme tokens */}
          <View className="flex-row items-center gap-2 mb-3">
            <EventTypeBadge type={event.event_type} />
            <StatusChip status={event.status} />
          </View>

          {/* Description (if the organizer set one) */}
          {event.description ? (
            <Text className={`text-sm mb-3 leading-5 ${t.textSecondary}`}>{event.description}</Text>
          ) : null}

          {/* Date range (shown only if at least one date is set) */}
          {(event.start_date || event.end_date) && (
            <View className="flex-row items-center gap-1 mb-2">
              <Ionicons name="calendar-outline" size={14} color={t.colors.tabBarInactive} />
              <Text className={`text-xs ${t.textTertiary}`}>
                {event.start_date ? apiToDisplay(event.start_date) : "—"}
                {event.end_date ? ` → ${apiToDisplay(event.end_date)}` : ""}
              </Text>
            </View>
          )}

          {/* Footer: creator name + member count */}
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
                    // Draw a divider under every row except the last
                    idx < event.members.length - 1 ? `border-b ${t.divider}` : ""
                  }`}
                >
                  {/* Initials avatar — green-100/green-700 is categorical, not themed */}
                  <View className="w-9 h-9 rounded-full bg-green-100 items-center justify-center flex-shrink-0">
                    <Text className="text-green-700 font-bold text-sm">
                      {member.display_name.charAt(0).toUpperCase()}
                    </Text>
                  </View>

                  {/* Name + email — min-w-0 prevents text from overflowing the flex container */}
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
            onAction={() => setScheduleRoundModalVisible(true)}
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
                // Round cards are tappable — they navigate to the Round detail/edit screen.
                // app/rounds/[id].tsx handles group management, tee times, and player assignment.
                // (That screen is not yet built; Expo Router shows "Unmatched Route" until it exists.)
                <TouchableOpacity
                  key={round.id}
                  className={`${t.surface} rounded-2xl p-4 border ${t.border}`}
                  onPress={() => router.push(`/rounds/${round.id}`)}
                  activeOpacity={0.7}
                >
                  {/* Round number + status chip — RoundStatusChip is categorical, not themed */}
                  <View className="flex-row items-center justify-between mb-2">
                    <Text className={`font-bold text-sm ${t.textPrimary}`}>
                      Round {round.round_number}
                    </Text>
                    <RoundStatusChip status={round.status} />
                  </View>

                  {/* Course name */}
                  <View className="flex-row items-center gap-1 mb-1">
                    <Ionicons name="golf-outline" size={13} color={t.colors.tabBarInactive} />
                    <Text className={`text-sm ${t.textSecondary}`}>{round.course_name}</Text>
                  </View>

                  {/* Date + scoring format */}
                  <View className="flex-row items-center justify-between">
                    <View className="flex-row items-center gap-1">
                      <Ionicons name="calendar-outline" size={13} color={t.colors.tabBarInactive} />
                      <Text className={`text-xs ${t.textSecondary}`}>
                        {apiToDisplay(round.scheduled_date)}
                      </Text>
                    </View>
                    {/* capitalize: CSS text-transform — makes "net_stroke" → "net stroke"
                        after the .replace("_", " ") call */}
                    <Text className={`text-xs capitalize ${t.textTertiary}`}>
                      {round.scoring_format.replace("_", " ")}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* ── Edit Event Modal ───────────────────────────────────────────────── */}
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
                title="Edit Event"
                onClose={() => setEditModalVisible(false)}
                disabled={updateEventMutation.isPending}
              />

              {/* Name */}
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

              {/* Description */}
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

              {/* Start date — DateInput handles auto-formatting and the native calendar picker */}
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

              {/* End date */}
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

              {/* Save button */}
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

            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* ── Add Member Modal ───────────────────────────────────────────────── */}
      {/* ══════════════════════════════════════════════════════════════════════ */}

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

          {/* Header area with padding */}
          <View className="px-5 pt-8 pb-2">
            <ModalHeader
              title="Add Member"
              onClose={() => {
                setAddMemberModalVisible(false);
                setMemberSearch("");
              }}
            />
          </View>

          {/* UserSearchList owns the search box and list.
              We pass pre-filtered users (non-members only); the component filters by search text.
              The search state is owned here so we can reset it when the modal closes. */}
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

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* ── Schedule Round Modal ───────────────────────────────────────────── */}
      {/* ══════════════════════════════════════════════════════════════════════ */}

      <Modal
        visible={scheduleRoundModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setScheduleRoundModalVisible(false)}
      >
        <KeyboardAvoidingView
          className={`flex-1 ${t.surface}`}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView>
            <View className="px-5 pt-8 pb-10">

              <ModalHeader
                title="Schedule Round"
                onClose={() => setScheduleRoundModalVisible(false)}
                disabled={scheduleRoundMutation.isPending}
              />

              {/* Course name */}
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
                {/* Hint: existing courses are matched by name so no duplicates are created */}
                <Text className={`text-xs mt-1 ml-1 ${t.textTertiary}`}>
                  Existing courses are matched by name — no duplicates created.
                </Text>
              </View>

              {/* Date — DateInput handles auto-formatting and native calendar picker */}
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
                  chunk(SCORING_FORMATS, 2) → [[Stroke, Net], [Stableford, Scramble]]
                  We render each inner array as a flex-row, avoiding duplicate JSX. */}
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
                            // flex-1: each pill takes equal width within the row
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

              {/* Schedule button */}
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
