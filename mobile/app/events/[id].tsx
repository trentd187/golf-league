// app/events/[id].tsx
// Event Detail screen — shown when a user taps an event card in the Events tab.
// This screen is a full-page stack screen (no tab bar) pushed on top of the tabs.
//
// It has three sections:
//   1. Event info   — name, type, status, description, dates, creator
//   2. Members      — roster list; organizers see an "Add Member" button
//   3. Rounds       — scheduled/active/completed rounds; organizers see "Schedule Round"
//
// Organizer actions (edit, add member, schedule round) open modal sheets.
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
  FlatList,
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

// --- Types (matching the backend response shapes) ---

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

type UserSummary = {
  id: string;
  display_name: string;
  email: string;
};

// --- Scoring format options for the Schedule Round form ---
const SCORING_FORMATS: { value: string; label: string }[] = [
  { value: "stroke",     label: "Stroke" },
  { value: "net_stroke", label: "Net" },
  { value: "stableford", label: "Stableford" },
  { value: "scramble",   label: "Scramble" },
];

// --- Small reusable sub-components ---

// EventTypeBadge: coloured pill showing "League", "Tournament", or "Casual"
function EventTypeBadge({ type }: { type: EventDetail["event_type"] }) {
  const map = {
    league:     { bg: "bg-blue-100",  text: "text-blue-700" },
    tournament: { bg: "bg-amber-100", text: "text-amber-700" },
    casual:     { bg: "bg-gray-100",  text: "text-gray-600" },
  };
  const s = map[type];
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  return (
    <View className={`self-start rounded-full px-2 py-0.5 ${s.bg}`}>
      <Text className={`text-xs font-semibold ${s.text}`}>{label}</Text>
    </View>
  );
}

// StatusChip: coloured pill showing the event lifecycle status
function StatusChip({ status }: { status: string }) {
  const map: Record<string, { bg: string; text: string }> = {
    upcoming:  { bg: "bg-sky-100",   text: "text-sky-700" },
    active:    { bg: "bg-green-100", text: "text-green-700" },
    completed: { bg: "bg-gray-100",  text: "text-gray-600" },
    cancelled: { bg: "bg-red-100",   text: "text-red-600" },
  };
  const s = map[status] ?? map.upcoming;
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <View className={`self-start rounded-full px-2 py-0.5 ${s.bg}`}>
      <Text className={`text-xs font-semibold ${s.text}`}>{label}</Text>
    </View>
  );
}

// RoleBadge: shows "Organizer" badge next to a member's name (hidden for regular players)
function RoleBadge({ role }: { role: string }) {
  if (role !== "organizer") return null;
  return (
    <View className="rounded-full px-2 py-0.5 bg-green-100">
      <Text className="text-xs font-semibold text-green-700">Organizer</Text>
    </View>
  );
}

// RoundStatusChip: small coloured label for a round's status
function RoundStatusChip({ status }: { status: string }) {
  const map: Record<string, { bg: string; text: string }> = {
    scheduled: { bg: "bg-sky-100",   text: "text-sky-700" },
    active:    { bg: "bg-green-100", text: "text-green-700" },
    completed: { bg: "bg-gray-100",  text: "text-gray-600" },
  };
  const s = map[status] ?? map.scheduled;
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <View className={`self-start rounded-full px-2 py-0.5 ${s.bg}`}>
      <Text className={`text-xs font-semibold ${s.text}`}>{label}</Text>
    </View>
  );
}

// SectionHeader: consistent heading row used for "Members" and "Rounds" sections
function SectionHeader({
  title,
  actionLabel,
  onAction,
  showAction,
}: {
  title: string;
  actionLabel: string;
  onAction: () => void;
  showAction: boolean;
}) {
  return (
    <View className="flex-row items-center justify-between mb-3">
      <Text className="text-base font-bold text-gray-800">{title}</Text>
      {showAction && (
        <TouchableOpacity
          className="bg-green-700 rounded-xl px-3 py-1.5 flex-row items-center gap-1"
          onPress={onAction}
        >
          <Ionicons name="add" size={15} color="white" />
          <Text className="text-white font-semibold text-xs">{actionLabel}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// --- Main screen ---

export default function EventDetailScreen() {
  // Read the dynamic segment from the URL: /events/[id] → params.id
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { getToken } = useAuth();
  const { user } = useUser();
  const queryClient = useQueryClient();

  // --- Modal visibility state ---
  const [editModalVisible, setEditModalVisible]             = useState(false);
  const [addMemberModalVisible, setAddMemberModalVisible]   = useState(false);
  const [scheduleRoundModalVisible, setScheduleRoundModalVisible] = useState(false);

  // --- Edit event form state ---
  const [editName, setEditName]             = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editStartDate, setEditStartDate]   = useState("");
  const [editEndDate, setEditEndDate]       = useState("");

  // --- Add member search state ---
  const [memberSearch, setMemberSearch] = useState("");

  // --- Schedule round form state ---
  const [courseName, setCourseName]         = useState("");
  const [roundDate, setRoundDate]           = useState("");
  const [scoringFormat, setScoringFormat]   = useState("stroke");

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
    enabled: !!id, // only run when id is available (Expo Router might render before params are set)
  });

  // --- Fetch rounds for this event ---
  const {
    data: rounds,
    isLoading: roundsLoading,
    refetch: refetchRounds,
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
    // Only fetch the user list when the Add Member modal is open
    enabled: addMemberModalVisible,
  });

  // --- Determine if the current user is an organizer ---
  // We match by email because that's what Clerk exposes and what our DB uses as the unique key.
  const myEmail = user?.primaryEmailAddress?.emailAddress;
  const myMembership = event?.members.find((m) => m.email === myEmail);
  const isOrganizer = myMembership?.role === "organizer";

  // --- Filter users for the Add Member picker ---
  // Exclude users who are already members of this event, then apply the search query.
  const existingMemberIds = new Set(event?.members.map((m) => m.user_id) ?? []);
  const availableUsers = (allUsers ?? []).filter((u) => {
    if (existingMemberIds.has(u.id)) return false;
    if (!memberSearch.trim()) return true;
    const q = memberSearch.toLowerCase();
    return u.display_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

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
      // Invalidate both the detail query and the events list so everything stays in sync
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
    // Dates come from the API as YYYY-MM-DD — convert them to MM-DD-YY for the DateInput.
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
      <View className="flex-1 bg-gray-50 items-center justify-center">
        <ActivityIndicator size="large" color="#15803d" />
      </View>
    );
  }

  if (eventError || !event) {
    return (
      <View className="flex-1 bg-gray-50 items-center justify-center gap-3 px-8">
        <Ionicons name="alert-circle-outline" size={48} color="#dc2626" />
        <Text className="text-gray-700 font-semibold text-center">Failed to load event</Text>
        <TouchableOpacity
          className="bg-green-700 rounded-xl px-6 py-3"
          onPress={() => refetchEvent()}
        >
          <Text className="text-white font-semibold">Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // --- Main render ---
  return (
    <View className="flex-1 bg-gray-50">

      {/* ── Custom back header ─────────────────────────────────────────────── */}
      {/* We hide the default Stack header (headerShown: false in _layout) and
          render our own so we can control its appearance precisely. */}
      <View className="bg-white border-b border-gray-100 px-4 pt-14 pb-3 flex-row items-center gap-3">
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color="#374151" />
        </TouchableOpacity>
        <Text className="text-lg font-bold text-gray-900 flex-1" numberOfLines={1}>
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
        <View className="bg-white rounded-2xl p-4 mb-4 border border-gray-100">

          {/* Type badge + status chip on one row */}
          <View className="flex-row items-center gap-2 mb-3">
            <EventTypeBadge type={event.event_type} />
            <StatusChip status={event.status} />
          </View>

          {/* Description (if set) */}
          {event.description ? (
            <Text className="text-gray-600 text-sm mb-3 leading-5">{event.description}</Text>
          ) : null}

          {/* Date range (if either date is set).
              apiToDisplay converts "YYYY-MM-DD" → "MM-DD-YY" for display. */}
          {(event.start_date || event.end_date) && (
            <View className="flex-row items-center gap-1 mb-2">
              <Ionicons name="calendar-outline" size={14} color="#9ca3af" />
              <Text className="text-gray-500 text-xs">
                {event.start_date ? apiToDisplay(event.start_date) : "—"}
                {event.end_date ? ` → ${apiToDisplay(event.end_date)}` : ""}
              </Text>
            </View>
          )}

          {/* Footer: creator + member count */}
          <View className="flex-row items-center justify-between mt-1">
            <Text className="text-gray-400 text-xs">Created by {event.creator_name}</Text>
            <View className="flex-row items-center gap-1">
              <Ionicons name="people-outline" size={13} color="#9ca3af" />
              <Text className="text-gray-400 text-xs">{event.member_count} members</Text>
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
            <Text className="text-gray-400 text-sm text-center py-4">No members yet.</Text>
          ) : (
            <View className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              {event.members.map((member, idx) => (
                <View
                  key={member.user_id}
                  className={`px-4 py-3 flex-row items-center gap-3 ${
                    idx < event.members.length - 1 ? "border-b border-gray-100" : ""
                  }`}
                >
                  {/* Avatar: circle with first initial */}
                  <View className="w-9 h-9 rounded-full bg-green-100 items-center justify-center flex-shrink-0">
                    <Text className="text-green-700 font-bold text-sm">
                      {member.display_name.charAt(0).toUpperCase()}
                    </Text>
                  </View>

                  {/* Name + email */}
                  <View className="flex-1 min-w-0">
                    <Text className="text-gray-800 font-semibold text-sm" numberOfLines={1}>
                      {member.display_name}
                    </Text>
                    <Text className="text-gray-400 text-xs" numberOfLines={1}>
                      {member.email}
                    </Text>
                  </View>

                  {/* Organizer badge (only shown when role = organizer) */}
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
            <ActivityIndicator color="#15803d" />
          ) : !rounds || rounds.length === 0 ? (
            <Text className="text-gray-400 text-sm text-center py-4">
              {isOrganizer
                ? 'Tap "Schedule" to add the first round.'
                : "No rounds scheduled yet."}
            </Text>
          ) : (
            <View className="gap-3">
              {rounds.map((round) => (
                <View
                  key={round.id}
                  className="bg-white rounded-2xl p-4 border border-gray-100"
                >
                  {/* Round number + status */}
                  <View className="flex-row items-center justify-between mb-2">
                    <Text className="text-gray-800 font-bold text-sm">
                      Round {round.round_number}
                    </Text>
                    <RoundStatusChip status={round.status} />
                  </View>

                  {/* Course name */}
                  <View className="flex-row items-center gap-1 mb-1">
                    <Ionicons name="golf-outline" size={13} color="#9ca3af" />
                    <Text className="text-gray-600 text-sm">{round.course_name}</Text>
                  </View>

                  {/* Date + scoring format.
                      scheduled_date comes from the API as "YYYY-MM-DD" — convert to "MM-DD-YY". */}
                  <View className="flex-row items-center justify-between">
                    <View className="flex-row items-center gap-1">
                      <Ionicons name="calendar-outline" size={13} color="#9ca3af" />
                      <Text className="text-gray-500 text-xs">{apiToDisplay(round.scheduled_date)}</Text>
                    </View>
                    <Text className="text-gray-400 text-xs capitalize">
                      {round.scoring_format.replace("_", " ")}
                    </Text>
                  </View>
                </View>
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
          className="flex-1 bg-white"
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView>
            <View className="px-5 pt-8 pb-10">

              {/* Modal header */}
              <View className="flex-row items-center justify-between mb-8">
                <Text className="text-xl font-bold text-gray-900">Edit Event</Text>
                <TouchableOpacity
                  onPress={() => setEditModalVisible(false)}
                  disabled={updateEventMutation.isPending}
                >
                  <Ionicons name="close" size={24} color="#6b7280" />
                </TouchableOpacity>
              </View>

              {/* Name */}
              <View className="mb-4">
                <Text className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">
                  Name <Text className="text-red-500">*</Text>
                </Text>
                <TextInput
                  className="border border-gray-300 rounded-xl px-4 py-3 text-base bg-gray-50"
                  value={editName}
                  onChangeText={setEditName}
                  autoCapitalize="words"
                  editable={!updateEventMutation.isPending}
                  returnKeyType="next"
                />
              </View>

              {/* Description */}
              <View className="mb-4">
                <Text className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">
                  Description{" "}
                  <Text className="text-gray-400 normal-case font-normal">(optional)</Text>
                </Text>
                <TextInput
                  className="border border-gray-300 rounded-xl px-4 py-3 text-base bg-gray-50"
                  value={editDescription}
                  onChangeText={setEditDescription}
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                  editable={!updateEventMutation.isPending}
                />
              </View>

              {/* Start date — DateInput handles auto-formatting and native calendar picker */}
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
                  updateEventMutation.isPending ? "bg-green-400" : "bg-green-700"
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
        <View className="flex-1 bg-white">
          {/* Modal header */}
          <View className="px-5 pt-8 pb-4">
            <View className="flex-row items-center justify-between mb-4">
              <Text className="text-xl font-bold text-gray-900">Add Member</Text>
              <TouchableOpacity
                onPress={() => {
                  setAddMemberModalVisible(false);
                  setMemberSearch("");
                }}
              >
                <Ionicons name="close" size={24} color="#6b7280" />
              </TouchableOpacity>
            </View>

            {/* Search box */}
            <View className="flex-row items-center border border-gray-300 rounded-xl px-3 py-2 bg-gray-50">
              <Ionicons name="search-outline" size={16} color="#9ca3af" />
              <TextInput
                className="flex-1 ml-2 text-base text-gray-800"
                placeholder="Search by name or email..."
                value={memberSearch}
                onChangeText={setMemberSearch}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          </View>

          {/* User list */}
          {!allUsers ? (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator size="large" color="#15803d" />
            </View>
          ) : availableUsers.length === 0 ? (
            <View className="flex-1 items-center justify-center px-8">
              <Text className="text-gray-400 text-sm text-center">
                {memberSearch
                  ? "No users match your search."
                  : "All users are already members of this event."}
              </Text>
            </View>
          ) : (
            <FlatList
              data={availableUsers}
              keyExtractor={(item) => item.id}
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  className="flex-row items-center gap-3 py-3 border-b border-gray-100"
                  onPress={() => addMemberMutation.mutate(item.id)}
                  disabled={addMemberMutation.isPending}
                >
                  {/* Initials avatar */}
                  <View className="w-10 h-10 rounded-full bg-green-100 items-center justify-center flex-shrink-0">
                    <Text className="text-green-700 font-bold">
                      {item.display_name.charAt(0).toUpperCase()}
                    </Text>
                  </View>

                  {/* Name + email */}
                  <View className="flex-1 min-w-0">
                    <Text className="text-gray-800 font-semibold text-sm" numberOfLines={1}>
                      {item.display_name}
                    </Text>
                    <Text className="text-gray-400 text-xs" numberOfLines={1}>
                      {item.email}
                    </Text>
                  </View>

                  {/* Add indicator */}
                  {addMemberMutation.isPending ? (
                    <ActivityIndicator size="small" color="#15803d" />
                  ) : (
                    <Ionicons name="add-circle-outline" size={22} color="#15803d" />
                  )}
                </TouchableOpacity>
              )}
            />
          )}
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
          className="flex-1 bg-white"
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView>
            <View className="px-5 pt-8 pb-10">

              {/* Modal header */}
              <View className="flex-row items-center justify-between mb-8">
                <Text className="text-xl font-bold text-gray-900">Schedule Round</Text>
                <TouchableOpacity
                  onPress={() => setScheduleRoundModalVisible(false)}
                  disabled={scheduleRoundMutation.isPending}
                >
                  <Ionicons name="close" size={24} color="#6b7280" />
                </TouchableOpacity>
              </View>

              {/* Course name */}
              <View className="mb-4">
                <Text className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">
                  Course Name <Text className="text-red-500">*</Text>
                </Text>
                <TextInput
                  className="border border-gray-300 rounded-xl px-4 py-3 text-base bg-gray-50"
                  placeholder="e.g. Pine Valley Golf Club"
                  value={courseName}
                  onChangeText={setCourseName}
                  autoCapitalize="words"
                  editable={!scheduleRoundMutation.isPending}
                  returnKeyType="next"
                />
                {/* Hint: if the course already exists it will be reused */}
                <Text className="text-gray-400 text-xs mt-1 ml-1">
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

              {/* Scoring format picker — pill buttons */}
              <View className="mb-8">
                <Text className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">
                  Scoring Format
                </Text>
                {/* Two rows of two pills each */}
                <View className="gap-2">
                  <View className="flex-row gap-2">
                    {SCORING_FORMATS.slice(0, 2).map((fmt) => {
                      const selected = scoringFormat === fmt.value;
                      return (
                        <TouchableOpacity
                          key={fmt.value}
                          className={`flex-1 rounded-xl py-3 items-center border ${
                            selected ? "bg-green-700 border-green-700" : "bg-white border-gray-300"
                          }`}
                          onPress={() => setScoringFormat(fmt.value)}
                          disabled={scheduleRoundMutation.isPending}
                        >
                          <Text
                            className={`text-sm font-semibold ${
                              selected ? "text-white" : "text-gray-600"
                            }`}
                          >
                            {fmt.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                  <View className="flex-row gap-2">
                    {SCORING_FORMATS.slice(2).map((fmt) => {
                      const selected = scoringFormat === fmt.value;
                      return (
                        <TouchableOpacity
                          key={fmt.value}
                          className={`flex-1 rounded-xl py-3 items-center border ${
                            selected ? "bg-green-700 border-green-700" : "bg-white border-gray-300"
                          }`}
                          onPress={() => setScoringFormat(fmt.value)}
                          disabled={scheduleRoundMutation.isPending}
                        >
                          <Text
                            className={`text-sm font-semibold ${
                              selected ? "text-white" : "text-gray-600"
                            }`}
                          >
                            {fmt.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              </View>

              {/* Schedule button */}
              <TouchableOpacity
                className={`rounded-xl py-4 items-center ${
                  scheduleRoundMutation.isPending ? "bg-green-400" : "bg-green-700"
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
