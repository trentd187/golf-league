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

// DateTimePicker is the native time/date picker from @react-native-community/datetimepicker.
// Already installed as a direct dependency for DateInput — no new package needed.
// We use it in "time" mode for the tee time pickers in the Schedule Round form.
import DateTimePicker, { DateTimePickerEvent } from "@react-native-community/datetimepicker";

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
// chunk: splits an array into equal-sized sub-arrays — used to render the
// scoring format pill grid as rows. Shared across screens via utils/array.ts.
import { chunk } from "@/utils/array";

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
  name: string;           // display name, e.g. "Round 1" or "Championship Round"
  course_name: string;
  scheduled_date: string; // "YYYY-MM-DD"
  status: string;         // "scheduled" | "active" | "completed"
  scoring_format: string;
  round_number: number;
  group_count: number;    // number of tee-time groups created for this round
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

// ─── Tee time helpers ─────────────────────────────────────────────────────────
// Tee times are stored internally as "HH:MM" (24-hour) strings — compact and easy
// to send to the backend. The native picker works with JS Date objects, so we
// convert back and forth as needed.

// teeTimeToDate converts "HH:MM" to a JS Date (using today's date, only the time matters).
// Falls back to the current time if the string is missing or unparseable.
function teeTimeToDate(hhmm: string): Date {
  const d = new Date();
  if (!hhmm) return d;
  const [h, m] = hhmm.split(":").map(Number);
  if (!isNaN(h) && !isNaN(m)) d.setHours(h, m, 0, 0);
  return d;
}

// dateToTeeTime converts a JS Date from the picker to "HH:MM" (24-hour string).
// padStart(2, "0") ensures single-digit values are zero-padded: 7 → "07".
function dateToTeeTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// formatTeeTime converts "HH:MM" to a human-readable "h:mm AM/PM" string for display.
// Example: "07:30" → "7:30 AM",  "13:45" → "1:45 PM"
function formatTeeTime(hhmm: string): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return hhmm;
  const ampm = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 || 12; // converts 0 → 12 (midnight) and 12 → 12 (noon)
  return `${hour12}:${String(m).padStart(2, "0")} ${ampm}`;
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
  // roundName: the display name for the new round. Pre-populated with "Round N" when the
  // modal opens, but the organizer can type any name they like.
  const [roundName, setRoundName]         = useState("");
  const [courseName, setCourseName]       = useState("");
  const [roundDate, setRoundDate]         = useState("");
  const [scoringFormat, setScoringFormat] = useState("stroke");
  // groupCount: how many tee-time groups to create with the round (1–8).
  const [groupCount, setGroupCount]         = useState(1);
  // groupTeeTimes: one entry per group (index 0 = Group 1, etc.).
  // Each entry is an HH:MM string like "07:30" or "" if no tee time is set.
  const [groupTeeTimes, setGroupTeeTimes]   = useState<string[]>([""]);

  // openTeeTimePicker: index of the group whose tee time picker is currently open,
  // or null when all pickers are closed. Only one can be open at a time.
  const [openTeeTimePicker, setOpenTeeTimePicker] = useState<number | null>(null);

  // updateGroupCount resizes groupTeeTimes to match the new count,
  // padding with "" for added groups or truncating when groups are removed.
  const updateGroupCount = (n: number) => {
    setGroupCount(n);
    setGroupTeeTimes((prev) => {
      const next = [...prev];
      while (next.length < n) next.push("");
      return next.slice(0, n);
    });
  };

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
      name: string;           // display name, e.g. "Round 1" or "Championship Round"
      course_name: string;
      scheduled_date: string;
      scoring_format: string;
      // groups: one entry per tee-time group; tee_time is optional ("HH:MM" or undefined)
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

  // --- Mutation: cancel event (status → "cancelled") ---
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
      // Refresh both the event detail and the events list so the status chip updates everywhere
      queryClient.invalidateQueries({ queryKey: ["event", id] });
      queryClient.invalidateQueries({ queryKey: ["events"] });
    },
    onError: (err: Error) => {
      Alert.alert("Could not cancel event", err.message, [{ text: "OK" }]);
    },
  });

  // --- Mutation: delete event (permanent) ---
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
      // Refresh the events list then navigate back — this event no longer exists
      queryClient.invalidateQueries({ queryKey: ["events"] });
      router.back();
    },
    onError: (err: Error) => {
      Alert.alert("Could not delete event", err.message, [{ text: "OK" }]);
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

  // handleCancelEvent: asks for confirmation then marks the event as cancelled.
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

  // handleDeleteEvent: asks for extra confirmation then permanently deletes the event.
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
      // Convert MM-DD-YY → YYYY-MM-DD before sending to the backend
      scheduled_date: displayToApi(roundDate.trim()),
      scoring_format: scoringFormat,
      // Build one entry per group; omit tee_time entirely if the field is blank
      // so the backend creates the group with TeeTime = null.
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
            onAction={() => {
              // Pre-populate the round name with "Round N" where N = current count + 1.
              // rounds?.length is the number of rounds already scheduled for this event.
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
                // Round cards are tappable — they navigate to the Round detail/edit screen.
                // app/rounds/[id].tsx handles group management, tee times, and player assignment.
                // (That screen is not yet built; Expo Router shows "Unmatched Route" until it exists.)
                <TouchableOpacity
                  key={round.id}
                  className={`${t.surface} rounded-2xl p-4 border ${t.border}`}
                  onPress={() => router.push(`/rounds/${round.id}`)}
                  activeOpacity={0.7}
                >
                  {/* Round name + status chip — RoundStatusChip is categorical, not themed */}
                  <View className="flex-row items-center justify-between mb-2">
                    <Text className={`font-bold text-sm ${t.textPrimary}`}>
                      {round.name}
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
                    {/* Show scoring format and group count, e.g. "Stroke · 3 groups" */}
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

              {/* ── Danger zone ──────────────────────────────────────────────────
                  Cancel and Delete live here inside the Edit modal so they are a
                  deliberate two-tap gesture (open Edit → tap action), preventing
                  accidental triggers from the main event card view. */}
              <View className={`mt-6 pt-6 border-t ${t.divider} gap-3`}>

                {/* Cancel Event — marks the event as "cancelled". Event data is
                    preserved and members can still view it. Disabled (and relabelled)
                    when the event is already cancelled so it's clear no action is needed. */}
                <TouchableOpacity
                  className={`rounded-xl py-4 items-center border ${
                    event.status === "cancelled"
                      ? "border-gray-200 bg-gray-50"   // greyed out — already cancelled
                      : "border-amber-200 bg-amber-50" // amber — active destructive action
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
                        // amber-600 when active; gray-400 when already cancelled
                        color: event.status === "cancelled" ? "#9ca3af" : "#d97706",
                      }}
                    >
                      {event.status === "cancelled" ? "Event Cancelled" : "Cancel Event"}
                    </Text>
                  )}
                </TouchableOpacity>

                {/* Delete Event — permanently removes the event and ALL its rounds,
                    members, and scores. This cannot be undone. A confirmation Alert
                    fires before the mutation is called (in handleDeleteEvent). */}
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

              {/* Round name — required; pre-populated with "Round N" but fully editable */}
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

              {/* ── Groups ───────────────────────────────────────────────────── */}
              {/* Lets the organizer choose how many tee-time groups to create (1–8)
                  and optionally enter a tee time for each group (HH:MM, 24-hour format).
                  Players are assigned to groups on the Round detail screen after creation. */}
              <View className="mb-8">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-3 ${t.textTertiary}`}>
                  Groups
                </Text>

                {/* +/- stepper for number of groups */}
                <View className="flex-row items-center gap-3 mb-4">
                  <TouchableOpacity
                    className={`w-10 h-10 rounded-xl border items-center justify-center ${t.borderInput} ${t.surfaceSunken}`}
                    onPress={() => updateGroupCount(Math.max(1, groupCount - 1))}
                    disabled={scheduleRoundMutation.isPending}
                  >
                    {/* "–" reduces the group count; minimum 1 */}
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
                    {/* "+" increases the group count; maximum 8 */}
                    <Text className={`text-lg font-bold ${t.textPrimary}`}>+</Text>
                  </TouchableOpacity>

                  <Text className={`text-sm ${t.textSecondary}`}>
                    {groupCount === 1 ? "group" : "groups"}
                  </Text>
                </View>

                {/* One tee time row per group.
                    Tapping the button opens the native time picker — no text entry.
                    Array.from generates an array of length groupCount to map over. */}
                <View className="gap-2">
                  {Array.from({ length: groupCount }, (_, i) => (
                    <View key={i} className="flex-row items-center gap-3">
                      <Text className={`text-sm font-semibold w-16 ${t.textSecondary}`}>
                        Group {i + 1}
                      </Text>

                      {/* Tappable tee time button — opens the native time picker.
                          Shows the formatted time when set, or a greyed placeholder. */}
                      <TouchableOpacity
                        className={`flex-1 border rounded-xl px-3 py-2 flex-row items-center justify-between ${t.borderInput} ${t.surfaceSunken}`}
                        onPress={() => setOpenTeeTimePicker(i)}
                        disabled={scheduleRoundMutation.isPending}
                        activeOpacity={0.7}
                      >
                        <Text
                          className={`text-sm ${groupTeeTimes[i] ? t.textPrimary : ""}`}
                          // Use inline style for the placeholder color hex — can't use className
                          // because placeholderTextColor only works as a prop on TextInput,
                          // and here we're using a plain Text inside TouchableOpacity.
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

                {/* ── Native time picker ─────────────────────────────────────────
                    Android: DateTimePicker shows its own system dialog. We render it
                    outside the map so there's only one instance. When dismissed or
                    confirmed, we close the picker and update the relevant group entry.

                    iOS: We use a transparent Modal with a bottom sheet (same pattern
                    as DateInput). The Modal sits inside the schedule round pageSheet
                    modal and overlays it correctly on iOS. */}

                {Platform.OS === "android" && openTeeTimePicker !== null && (
                  <DateTimePicker
                    value={teeTimeToDate(groupTeeTimes[openTeeTimePicker] ?? "")}
                    mode="time"
                    // "default" = the Android native time picker dialog
                    display="default"
                    // is24Hour={false}: show AM/PM selector (matches how times appear in the app)
                    is24Hour={false}
                    onChange={(event: DateTimePickerEvent, date?: Date) => {
                      // Close the picker first — Android dismisses its own dialog,
                      // but we need to clear our state flag.
                      const idx = openTeeTimePicker;
                      setOpenTeeTimePicker(null);
                      // event.type === "set" means the user pressed OK (not cancelled).
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
                    {/* Full-screen container — positions the sheet at the bottom */}
                    <View className="flex-1">
                      {/* Semi-transparent backdrop: tap anywhere outside the sheet to close */}
                      <TouchableOpacity
                        className="absolute inset-0 bg-black/40"
                        activeOpacity={1}
                        onPress={() => setOpenTeeTimePicker(null)}
                      />

                      {/* Bottom sheet */}
                      <View className={`absolute bottom-0 left-0 right-0 ${t.surface} rounded-t-2xl pb-8`}>
                        {/* Header: label on left, "Done" button on right */}
                        <View className={`flex-row items-center justify-between px-5 pt-4 pb-2 border-b ${t.divider}`}>
                          <Text className={`font-semibold ${t.textSecondary}`}>
                            {openTeeTimePicker !== null
                              ? `Group ${openTeeTimePicker + 1} Tee Time`
                              : "Tee Time"}
                          </Text>
                          <TouchableOpacity onPress={() => setOpenTeeTimePicker(null)}>
                            {/* "Done" uses the theme's active color — inline style required
                                because Text doesn't accept a color prop */}
                            <Text
                              className="font-semibold text-base"
                              // eslint-disable-next-line react-native/no-inline-styles
                              style={{ color: t.colors.tabBarActive }}
                            >
                              Done
                            </Text>
                          </TouchableOpacity>
                        </View>

                        {/* iOS spinner-style time picker.
                            We only render it when openTeeTimePicker is not null
                            (the outer Modal.visible already guards this, but
                            the null check also satisfies TypeScript). */}
                        {openTeeTimePicker !== null && (
                          <DateTimePicker
                            value={teeTimeToDate(groupTeeTimes[openTeeTimePicker] ?? "")}
                            mode="time"
                            display="spinner"
                            // Update the group's tee time live as the spinner scrolls.
                            // The user taps "Done" (above) to dismiss.
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
