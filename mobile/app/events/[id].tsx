// app/events/[id].tsx
// Event Detail screen — shown when a user taps an event card in the Events tab.
// This screen is a full-page stack screen (no tab bar) pushed on top of the tabs.
//
// Four tabs are shown below the event info card:
//   1. Members    — roster list; organizers see an "Add Member" button
//   2. Rounds     — scheduled/active/completed rounds; organizers see "Schedule Round"
//   3. Leaderboard — event standings (placeholder; populated once scoring is implemented)
//   4. Stats       — aggregate stats across all rounds (placeholder)
//
// Organizer actions (edit event, add member, schedule round, end event) are available
// via the edit pencil in the header and the "End Event" button in the info card.
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
  KeyboardAvoidingView,
  Platform,
  Switch,
} from "react-native";

import { useLocalSearchParams, useRouter } from "expo-router";
import { useAuth } from "@/hooks/useAuth";
import { useUser } from "@/hooks/useUser";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Scorecard } from "@/types/scorecard";
import Ionicons from "@expo/vector-icons/Ionicons";
import { API_URL } from "@/constants/api";
import { apiFetch } from "@/utils/api";
import { savePost } from "@/utils/savePost";

// DateInput: auto-formats typed input to MM-DD-YY and shows a native calendar picker.
// apiToDisplay/displayToApi handle YYYY-MM-DD ↔ MM-DD-YY conversion.
import DateInput, { apiToDisplay, displayToApi } from "@/components/DateInput";

// TimeInput is the shared tee-time field (native picker on iOS/Android, browser-native
// <input type="time"> on web). Used for per-group tee times in the Schedule Round form.
import TimeInput from "@/components/TimeInput";

import { useTheme } from "@/hooks/useTheme";
import { EventTypeBadge, StatusChip, RoleBadge, RoundStatusChip } from "@/components/badges";
import SectionHeader from "@/components/SectionHeader";
import ModalHeader from "@/components/ModalHeader";
// UserSummary is exported from UserSearchList so we can type the query data here.
import UserSearchList, { UserSummary } from "@/components/UserSearchList";
import CoursePickerModal from "@/components/CoursePickerModal";
import RoundFormFields from "@/components/RoundFormFields";
import { useRoundForm } from "@/hooks/useRoundForm";
import { buildRoundCoursePayload } from "@/utils/roundPayload";
import UserAvatar from "@/components/UserAvatar";
import { formatLabel, formatToPar } from "@/utils/scoringFormats";
import { buildStats } from "@/utils/stats";
import { buildEventTally } from "@/utils/vegas";
import { buildBestBallEventTally } from "@/utils/bestBall";
import { deriveFormatMatches } from "@/utils/formatTelemetry";
import VegasEventTally from "@/components/VegasEventTally";
import BestBallEventTally from "@/components/BestBallEventTally";
import { showAlert, showConfirm } from "@/utils/alerts";
import StatsCards from "@/components/StatsCards";

// ─── Types ────────────────────────────────────────────────────────────────────

type MemberResponse = {
  user_id: string;
  display_name: string;
  email: string;
  avatar_url: string | null;
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
  handicap_allowance: number | null; // 0–100; null = full handicap
  is_public: boolean;
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

  // --- Tab state ---
  const [activeTab, setActiveTab] = useState<"members" | "rounds" | "leaderboard" | "stats" | "requests" | "matches" | "teams">("members");

  // --- Edit event form state ---
  const [editName, setEditName]               = useState("");
  const [editDescription, setEditDescription]             = useState("");
  const [editStartDate, setEditStartDate]                 = useState("");
  const [editEndDate, setEditEndDate]                     = useState("");
  // Handicap allowance stored as display string (e.g. "90"); converted to number on submit.
  const [editHandicapAllowance, setEditHandicapAllowance] = useState("");
  const [editIsPublic, setEditIsPublic] = useState(false);

  // --- Add member search state (owned here so it resets when the modal closes) ---
  const [memberSearch, setMemberSearch] = useState("");

  // --- Schedule round form state ---
  const [roundName, setRoundName] = useState("");
  const [roundDate, setRoundDate] = useState("");
  // roundForm: shared course/tee/nine-hole/scoring-format state (see hooks/useRoundForm.ts).
  const roundForm = useRoundForm();
  const [groupCount, setGroupCount] = useState(1);
  // groupTeeTimes: one "HH:MM" string per group ("" = no tee time set).
  // Each TimeInput manages its own picker open/close state.
  const [groupTeeTimes, setGroupTeeTimes]   = useState<string[]>([""]);

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
      const res = await apiFetch(`${API_URL}/api/v1/events/${id}`, {
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
      const res = await apiFetch(`${API_URL}/api/v1/events/${id}/rounds`, {
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
      const res = await apiFetch(`${API_URL}/api/v1/users`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to fetch users");
      return res.json();
    },
    enabled: addMemberModalVisible, // only fetch when the Add Member modal is open
  });

  // completedRoundIds: IDs of rounds to aggregate for leaderboard/stats.
  // Empty array while rounds are still loading — useQueries handles the empty case gracefully.
  const completedRoundIds = (rounds ?? [])
    .filter((r) => r.status === "completed")
    .map((r) => r.id);

  // hasVegasRound gates the event-level Matches tab (any Vegas round in the event).
  const hasVegasRound = (rounds ?? []).some((r) => r.scoring_format === "las_vegas");
  // hasBestBallRound gates the event-level Teams tab (any Best Ball round in the event).
  const hasBestBallRound = (rounds ?? []).some((r) => r.scoring_format === "best_ball");

  // scorecardQueries: one query per completed round.
  // Lazy — only enabled when the user opens the Leaderboard or Stats tab to avoid
  // fetching N scorecard payloads while just browsing Members or Rounds.
  const scorecardQueries = useQueries({
    queries: completedRoundIds.map((roundId) => ({
      queryKey: ["scorecard", roundId],
      queryFn: async () => {
        const token = await getToken();
        const res = await apiFetch(`${API_URL}/api/v1/rounds/${roundId}/scorecard`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`Failed to fetch scorecard: ${res.status}`);
        return res.json() as Promise<Scorecard>;
      },
      enabled: !!id && (activeTab === "leaderboard" || activeTab === "stats" || activeTab === "matches" || activeTab === "teams"),
    })),
  });

  const scorecardsLoading = scorecardQueries.some((q) => q.isLoading);
  const scorecardsError   = scorecardQueries.some((q) => q.isError);
  // Only include scorecards that have fully loaded — partial results would skew the aggregate.
  const scorecards        = scorecardQueries
    .map((q) => q.data)
    .filter((sc): sc is Scorecard => sc !== undefined);

  // Join requests — only fetched when the organizer opens the Requests tab.
  const {
    data: joinRequests,
    isLoading: joinRequestsLoading,
  } = useQuery<MemberResponse[]>({
    queryKey: ["event", id, "join-requests"],
    queryFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/events/${id}/join-requests`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to fetch join requests: ${res.status}`);
      return res.json();
    },
    enabled: !!id && activeTab === "requests",
  });

  // --- Derived values ---

  // Match by email — that's what our DB uses as the unique key.
  const myEmail = user?.email;
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
      handicap_allowance?: number | null;
      is_public?: boolean;
    }) => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/events/${id}`, {
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
      showAlert("Update failed", err.message);
    },
  });

  const addMemberMutation = useMutation({
    mutationFn: async (userId: string) => {
      const token = await getToken();
      // savePost: stable Idempotency-Key + retry; the backend durable idempotency store
      // replays the original response so a cellular phantom (commit + lost ack) retry
      // can't add the same member twice.
      return savePost({
        url: `${API_URL}/api/v1/events/${id}/members`,
        token: token ?? "",
        body: { user_id: userId },
        label: "event-member",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["event", id] });
      setAddMemberModalVisible(false);
      setMemberSearch("");
    },
    onError: (err: Error) => {
      showAlert("Could not add member", err.message);
    },
  });

  const scheduleRoundMutation = useMutation({
    mutationFn: async (data: {
      name: string;
      scheduled_date: string;
      scoring_format: string;
      groups: { tee_time?: string }[];
      course_id?: string;
      default_tee_id?: string;
      course_name?: string;
      nine_hole_selection?: string;
    }) => {
      const token = await getToken();
      // savePost: stable Idempotency-Key + retry; the backend durable idempotency store
      // replays the original response so a cellular phantom (commit + lost ack) retry
      // can't schedule a duplicate round under the event.
      return savePost({
        url: `${API_URL}/api/v1/events/${id}/rounds`,
        token: token ?? "",
        body: data,
        label: "event-round",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["event", id, "rounds"] });
      setScheduleRoundModalVisible(false);
      setRoundName("");
      roundForm.resetForm();
      setRoundDate("");
      setGroupCount(1);
      setGroupTeeTimes([""]);
    },
    onError: (err: Error) => {
      showAlert("Could not schedule round", err.message);
    },
  });

  // endEventMutation: marks the event as completed via PATCH /events/:id.
  // The backend already accepts status: "completed" in UpdateEvent.
  const endEventMutation = useMutation({
    mutationFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/events/${id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
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
      showAlert("Could not end event", err.message);
    },
  });

  const deleteEventMutation = useMutation({
    mutationFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/events/${id}`, {
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
      showAlert("Could not delete event", err.message);
    },
  });

  // handleJoinRequest: approve or deny a pending join request.
  const handleJoinRequestMutation = useMutation({
    mutationFn: async ({ userId, approve }: { userId: string; approve: boolean }) => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/events/${id}/join-requests/${userId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ approve }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["event", id] });
      queryClient.invalidateQueries({ queryKey: ["event", id, "join-requests"] });
    },
    onError: (err: Error) => {
      showAlert("Could not handle request", err.message);
    },
  });

  // updateMemberRoleMutation: promote or demote a member between organizer and player.
  const updateMemberRoleMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: "organizer" | "player" }) => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/events/${id}/members/${userId}/role`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["event", id] });
    },
    onError: (err: Error) => {
      showAlert("Could not update role", err.message);
    },
  });

  // --- Handlers ---

  const openEditModal = () => {
    // Dates from the API are YYYY-MM-DD — convert to MM-DD-YY for DateInput.
    setEditName(event?.name ?? "");
    setEditDescription(event?.description ?? "");
    setEditStartDate(apiToDisplay(event?.start_date));
    setEditEndDate(apiToDisplay(event?.end_date));
    setEditHandicapAllowance(event?.handicap_allowance != null ? String(event.handicap_allowance) : "");
    setEditIsPublic(event?.is_public ?? false);
    setEditModalVisible(true);
  };

  const handleSaveEdit = () => {
    if (!editName.trim()) {
      showAlert("Name required", "Event name cannot be empty.");
      return;
    }
    const allowanceStr = editHandicapAllowance.trim();
    let allowanceVal: number | null | undefined = undefined;
    if (allowanceStr === "") {
      // Empty string = clear the allowance (set to null = full handicap).
      allowanceVal = null;
    } else {
      const parsed = parseFloat(allowanceStr);
      if (isNaN(parsed) || parsed < 0 || parsed > 100) {
        showAlert("Invalid allowance", "Handicap allowance must be a number between 0 and 100.");
        return;
      }
      allowanceVal = parsed;
    }
    updateEventMutation.mutate({
      name: editName.trim(),
      description: editDescription,
      start_date: displayToApi(editStartDate.trim()),
      end_date: displayToApi(editEndDate.trim()),
      handicap_allowance: allowanceVal,
      is_public: editIsPublic,
    });
  };

  const handleEndEvent = () => {
    showConfirm(
      "End Event",
      "Mark this event as completed? This cannot be undone.",
      () => endEventMutation.mutate(),
      "End Event",
      "Cancel",
    );
  };

  const handleDeleteEvent = () => {
    showConfirm(
      "Delete event?",
      `"${event?.name}" and all its rounds will be permanently deleted. This cannot be undone.`,
      () => deleteEventMutation.mutate(),
      "Delete",
      "Keep",
    );
  };

  const handleScheduleRound = () => {
    if (!roundName.trim()) {
      showAlert("Name required", "Please enter a name for this round.");
      return;
    }
    if (!roundForm.selectedCourse) {
      showAlert("Course required", "Please select a golf course.");
      return;
    }
    if (roundForm.selectedCourse.tees.length > 0 && !roundForm.selectedTeeId) {
      showAlert("Tee required", "Please select a tee set for this course.");
      return;
    }
    if (!roundDate.trim()) {
      showAlert("Date required", "Please enter the round date (MM-DD-YY).");
      return;
    }

    // Omit tee_time entirely for blank entries so the backend stores TeeTime = null.
    const groups = Array.from({ length: groupCount }, (_, i) => {
      const tt = groupTeeTimes[i]?.trim();
      return tt ? { tee_time: tt } : {};
    });

    scheduleRoundMutation.mutate({
      name:           roundName.trim(),
      scheduled_date: displayToApi(roundDate.trim()),
      groups,
      ...buildRoundCoursePayload(
        roundForm.selectedCourse,
        roundForm.selectedTeeId,
        roundForm.nineHoleSelection,
        roundForm.scoringFormat,
        { birdieFlip: roundForm.vegasBirdieFlip, scoringBasis: roundForm.vegasScoringBasis },
        { scoringBasis: roundForm.bestBallScoringBasis },
      ),
    });
  };

  // --- Leaderboard + stats helpers ---

  // EventLeaderboardEntry: per-player aggregate across all completed rounds.
  type EventLeaderboardEntry = {
    user_id: string;
    display_name: string;
    rank: string;
    roundsPlayed: number;    // completed rounds the player participated in
    grossTotal: number;      // sum of gross scores across all completed rounds
    netTotal: number;        // sum of net scores across all completed rounds
    grossToPar: number | null; // null when any round lacks hole par data
    netToPar: number | null;
  };

  // buildEventLeaderboard: aggregates scores across all completed scorecards by user_id,
  // sorts by net (lowest first), and assigns rank strings.
  function buildEventLeaderboard(scs: Scorecard[]): EventLeaderboardEntry[] {
    const map = new Map<string, Omit<EventLeaderboardEntry, "rank">>();

    for (const sc of scs) {
      const holeMap = new Map(sc.holes.map((h) => [h.hole_number, h.par]));
      const hasHoles = sc.holes.length > 0;

      for (const group of sc.groups) {
        for (const p of group.players) {
          if (p.scores.length === 0) continue;
          const gross = p.scores.reduce((s, x) => s + x.gross_score, 0);
          const net   = p.scores.reduce((s, x) => s + x.net_score, 0);
          const parPlayed = hasHoles
            ? p.scores.reduce((s, x) => s + (holeMap.get(x.hole_number) ?? 0), 0)
            : 0;
          const roundGross = hasHoles ? gross - parPlayed : null;
          const roundNet   = hasHoles ? net   - parPlayed : null;

          const existing = map.get(p.user_id);
          if (existing) {
            existing.roundsPlayed++;
            existing.grossTotal += gross;
            existing.netTotal   += net;
            // If any round lacks hole par data, toPar becomes unavailable for the whole aggregate.
            if (existing.grossToPar !== null && roundGross !== null) {
              existing.grossToPar += roundGross;
              existing.netToPar = (existing.netToPar ?? 0) + roundNet!;
            } else {
              existing.grossToPar = null;
              existing.netToPar   = null;
            }
          } else {
            map.set(p.user_id, {
              user_id: p.user_id,
              display_name: p.display_name,
              roundsPlayed: 1,
              grossTotal: gross,
              netTotal: net,
              grossToPar: roundGross,
              netToPar: roundNet,
            });
          }
        }
      }
    }

    const entries = [...map.values()].sort((a, b) => {
      const aScore = a.netToPar ?? a.netTotal;
      const bScore = b.netToPar ?? b.netTotal;
      return aScore - bScore;
    });

    // Assign rank strings: tied players share a "T1" prefix.
    let rank = 1;
    return entries.map((e, i, arr) => {
      if (i > 0) {
        const prev = arr[i - 1];
        if ((e.netToPar ?? e.netTotal) !== (prev.netToPar ?? prev.netTotal)) rank = i + 1;
      }
      const isTied = entries.filter(
        (x) => (x.netToPar ?? x.netTotal) === (e.netToPar ?? e.netTotal)
      ).length > 1;
      return { ...e, rank: isTied ? `T${rank}` : `${rank}` };
    });
  }

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
            {event.is_public && (
              <View className="flex-row items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200">
                <Ionicons name="globe-outline" size={11} color="#2563eb" />
                <Text className="text-xs font-semibold text-blue-700">Public</Text>
              </View>
            )}
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

          {event.handicap_allowance != null && (
            <View className="flex-row items-center gap-1 mb-2">
              <Ionicons name="golf-outline" size={14} color={t.colors.tabBarInactive} />
              <Text className={`text-xs ${t.textTertiary}`}>
                {event.handicap_allowance}% handicap allowance
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

          {/* End Event — organizer only, active events only */}
          {isOrganizer && event.status === "active" && (
            <TouchableOpacity
              className={`mt-3 flex-row items-center justify-center gap-2 rounded-xl py-2.5 border ${
                endEventMutation.isPending
                  ? `opacity-50 ${t.border} ${t.surface}`
                  : `${t.border} ${t.surface}`
              }`}
              onPress={handleEndEvent}
              disabled={endEventMutation.isPending}
              activeOpacity={0.8}
            >
              {endEventMutation.isPending ? (
                <ActivityIndicator size="small" color={t.colors.tabBarInactive} />
              ) : (
                <>
                  <Ionicons name="flag-outline" size={15} color={t.colors.tabBarInactive} />
                  <Text className={`font-medium text-sm ${t.textSecondary}`}>End Event</Text>
                </>
              )}
            </TouchableOpacity>
          )}

        </View>

        {/* ── Tab bar ────────────────────────────────────────────────────────── */}
        {/* "Requests" tab only appears for organizers of public events */}
        <View className="flex-row gap-2 mb-5">
          {(["members", "rounds", "leaderboard", "stats",
            ...(hasVegasRound ? ["matches"] : []),
            ...(hasBestBallRound ? ["teams"] : []),
            ...(isOrganizer && event.is_public ? ["requests"] : []),
          ] as const).map((tab) => {
            const isActive = activeTab === tab;
            return (
              <TouchableOpacity
                key={tab}
                className={`flex-1 rounded-full py-2 items-center border ${
                  isActive ? `${t.primaryBg} border-transparent` : `${t.surface} ${t.border}`
                }`}
                onPress={() => setActiveTab(tab as typeof activeTab)}
                activeOpacity={0.8}
              >
                <Text className={`text-sm font-semibold ${isActive ? "text-white" : t.textSecondary}`}>
                  {tab === "requests" ? "Requests" : tab.charAt(0).toUpperCase() + tab.slice(1)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Members section ────────────────────────────────────────────────── */}
        {activeTab === "members" && <View className="mb-4">
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
                  <TouchableOpacity
                    className="flex-row items-center gap-3 flex-1 min-w-0"
                    activeOpacity={0.7}
                    onPress={() => router.push(`/users/${member.user_id}`)}
                  >
                    <UserAvatar avatarUrl={member.avatar_url} displayName={member.display_name} size={36} />
                    <View className="flex-1 min-w-0">
                      <Text className={`font-semibold text-sm ${t.textPrimary}`} numberOfLines={1}>
                        {member.display_name}
                      </Text>
                      <Text className={`text-xs ${t.textTertiary}`} numberOfLines={1}>
                        {member.email}
                      </Text>
                    </View>
                  </TouchableOpacity>

                  <RoleBadge role={member.role} />

                  {/* Promote/demote — organizers only, not for yourself */}
                  {isOrganizer && member.email !== myEmail && (
                    <TouchableOpacity
                      hitSlop={8}
                      onPress={() => {
                        const newRole = member.role === "organizer" ? "player" : "organizer";
                        const action = newRole === "organizer" ? "Promote to organizer?" : "Remove organizer role?";
                        const message = newRole === "organizer"
                          ? `${member.display_name} will be able to manage this event.`
                          : `${member.display_name} will become a regular player.`;
                        showConfirm(
                          action,
                          message,
                          () => updateMemberRoleMutation.mutate({ userId: member.user_id, role: newRole }),
                          "Confirm",
                          "Cancel",
                        );
                      }}
                    >
                      <Ionicons
                        name={member.role === "organizer" ? "shield-checkmark-outline" : "shield-outline"}
                        size={18}
                        color={member.role === "organizer" ? t.colors.tabBarActive : t.colors.tabBarInactive}
                      />
                    </TouchableOpacity>
                  )}
                </View>
              ))}
            </View>
          )}
        </View>}

        {/* ── Rounds section ─────────────────────────────────────────────────── */}
        {activeTab === "rounds" && <View className="mb-8">
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
                    <Text className={`text-xs ${t.textTertiary}`}>
                      {formatLabel(round.scoring_format)}
                      {" · "}
                      {round.group_count} {round.group_count === 1 ? "group" : "groups"}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>}

        {/* ── Leaderboard tab ─────────────────────────────────────────────────── */}
        {activeTab === "leaderboard" && (
          <View className="mb-8">
            {completedRoundIds.length === 0 ? (
              <View className={`${t.surface} rounded-2xl border ${t.border} p-6 items-center gap-2`}>
                <Ionicons name="trophy-outline" size={32} color={t.colors.tabBarInactive} />
                <Text className={`text-sm text-center ${t.textSecondary}`}>
                  No completed rounds yet. Standings will appear once a round is finished.
                </Text>
              </View>
            ) : scorecardsLoading ? (
              <ActivityIndicator size="large" color={t.colors.tabBarActive} className="mt-8" />
            ) : scorecardsError ? (
              <Text className={`text-center mt-8 text-sm ${t.textSecondary}`}>
                Failed to load scores.
              </Text>
            ) : (() => {
              const entries = buildEventLeaderboard(scorecards);
              const hasParData = entries.some((e) => e.grossToPar !== null);
              if (entries.length === 0) {
                return (
                  <View className={`${t.surface} rounded-2xl border ${t.border} p-6 items-center gap-2`}>
                    <Ionicons name="trophy-outline" size={32} color={t.colors.tabBarInactive} />
                    <Text className={`text-sm text-center ${t.textSecondary}`}>No scores yet.</Text>
                  </View>
                );
              }
              return (
                <View className={`${t.surface} rounded-2xl border ${t.border} overflow-hidden`}>
                  {/* Column headers */}
                  <View className={`flex-row px-3 py-2 border-b ${t.divider}`}>
                    <Text className={`w-9 text-xs font-semibold ${t.textTertiary}`}> </Text>
                    <Text className={`flex-1 text-xs font-semibold ${t.textTertiary}`}>Player</Text>
                    <Text className={`w-10 text-xs font-semibold text-right ${t.textTertiary}`}>
                      Rnds
                    </Text>
                    <Text className={`w-12 text-xs font-semibold text-right ${t.textTertiary}`}>
                      Gross
                    </Text>
                    <Text className={`w-12 text-xs font-semibold text-right ${t.textTertiary}`}>
                      Net
                    </Text>
                  </View>
                  {entries.map((entry, idx) => {
                    const grossStr = hasParData
                      ? formatToPar(entry.grossToPar)
                      : String(entry.grossTotal);
                    const netStr = hasParData
                      ? formatToPar(entry.netToPar)
                      : String(entry.netTotal);
                    const netUnder = entry.netToPar !== null && entry.netToPar < 0;
                    const netOver  = entry.netToPar !== null && entry.netToPar > 0;
                    return (
                      <View
                        key={entry.user_id}
                        className={`flex-row items-center px-3 py-3 ${
                          idx < entries.length - 1 ? `border-b ${t.divider}` : ""
                        }`}
                      >
                        <Text className={`w-9 text-sm font-semibold ${t.textTertiary}`}>
                          {entry.rank}
                        </Text>
                        <Text
                          className={`flex-1 text-sm font-semibold ${t.textPrimary}`}
                          numberOfLines={1}
                        >
                          {entry.display_name}
                        </Text>
                        <Text className={`w-10 text-sm text-right ${t.textSecondary}`}>
                          {entry.roundsPlayed}
                        </Text>
                        <Text className={`w-12 text-sm text-right ${t.textSecondary}`}>
                          {grossStr}
                        </Text>
                        <Text
                          className={`w-12 text-sm font-bold text-right ${
                            netUnder
                              ? "text-green-600"
                              : netOver
                              ? "text-red-500"
                              : t.textPrimary
                          }`}
                        >
                          {netStr}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              );
            })()}
          </View>
        )}

        {/* ── Stats tab ──────────────────────────────────────────────────────── */}
        {activeTab === "stats" && (
          <View className="mb-8">
            {completedRoundIds.length === 0 ? (
              <View className={`${t.surface} rounded-2xl border ${t.border} p-6 items-center gap-2`}>
                <Ionicons name="bar-chart-outline" size={32} color={t.colors.tabBarInactive} />
                <Text className={`text-sm text-center ${t.textSecondary}`}>
                  No completed rounds yet. Stats will appear once a round is finished.
                </Text>
              </View>
            ) : scorecardsLoading ? (
              <ActivityIndicator size="large" color={t.colors.tabBarActive} className="mt-8" />
            ) : scorecardsError ? (
              <Text className={`text-center mt-8 text-sm ${t.textSecondary}`}>
                Failed to load stats.
              </Text>
            ) : (
              <StatsCards stats={buildStats(scorecards)} />
            )}
          </View>
        )}

        {/* ── Matches tab — cumulative Las Vegas standings across the event ──── */}
        {activeTab === "matches" && (
          <View className="mb-8">
            {completedRoundIds.length === 0 ? (
              <View className={`${t.surface} rounded-2xl border ${t.border} p-6 items-center gap-2`}>
                <Ionicons name="people-outline" size={32} color={t.colors.tabBarInactive} />
                <Text className={`text-sm text-center ${t.textSecondary}`}>
                  No completed Vegas rounds yet. Team standings appear once a round is finished.
                </Text>
              </View>
            ) : scorecardsLoading ? (
              <ActivityIndicator size="large" color={t.colors.tabBarActive} className="mt-8" />
            ) : scorecardsError ? (
              <Text className={`text-center mt-8 text-sm ${t.textSecondary}`}>
                Failed to load matches.
              </Text>
            ) : (() => {
              const tallies = deriveFormatMatches(
                { format: "las_vegas", derivation: "event_tally" },
                () => buildEventTally(scorecards),
                [],
              );
              if (tallies.length === 0) {
                return (
                  <Text className={`text-center mt-8 text-sm ${t.textSecondary}`}>
                    No team matchups recorded. Assign teams on each Vegas round to build standings.
                  </Text>
                );
              }
              return <VegasEventTally tallies={tallies} />;
            })()}
          </View>
        )}

        {/* ── Teams tab — cumulative Best Ball standings across the event ────── */}
        {activeTab === "teams" && (
          <View className="mb-8">
            {completedRoundIds.length === 0 ? (
              <View className={`${t.surface} rounded-2xl border ${t.border} p-6 items-center gap-2`}>
                <Ionicons name="people-outline" size={32} color={t.colors.tabBarInactive} />
                <Text className={`text-sm text-center ${t.textSecondary}`}>
                  No completed Best Ball rounds yet. Team standings appear once a round is finished.
                </Text>
              </View>
            ) : scorecardsLoading ? (
              <ActivityIndicator size="large" color={t.colors.tabBarActive} className="mt-8" />
            ) : scorecardsError ? (
              <Text className={`text-center mt-8 text-sm ${t.textSecondary}`}>
                Failed to load team standings.
              </Text>
            ) : (() => {
              const tallies = deriveFormatMatches(
                { format: "best_ball", derivation: "event_tally" },
                () => buildBestBallEventTally(scorecards),
                [],
              );
              if (tallies.length === 0) {
                return (
                  <Text className={`text-center mt-8 text-sm ${t.textSecondary}`}>
                    No team results recorded. Assign teams on each Best Ball round to build standings.
                  </Text>
                );
              }
              return <BestBallEventTally tallies={tallies} />;
            })()}
          </View>
        )}

        {/* ── Join Requests tab — organizers of public events only ──────────── */}
        {activeTab === "requests" && (
          <View className="mb-8">
            <SectionHeader title="Join Requests" showAction={false} />
            {joinRequestsLoading ? (
              <ActivityIndicator color={t.colors.tabBarActive} />
            ) : !joinRequests || joinRequests.length === 0 ? (
              <View className={`${t.surface} rounded-2xl border ${t.border} p-6 items-center gap-2`}>
                <Ionicons name="person-add-outline" size={32} color={t.colors.tabBarInactive} />
                <Text className={`text-sm text-center ${t.textSecondary}`}>
                  No pending join requests.
                </Text>
              </View>
            ) : (
              <View className={`${t.surface} rounded-2xl border ${t.border} overflow-hidden`}>
                {joinRequests.map((req, idx) => (
                  <View
                    key={req.user_id}
                    className={`px-4 py-3 flex-row items-center gap-3 ${
                      idx < joinRequests.length - 1 ? `border-b ${t.divider}` : ""
                    }`}
                  >
                    <UserAvatar avatarUrl={req.avatar_url} displayName={req.display_name} size={36} />
                    <View className="flex-1 min-w-0">
                      <Text className={`font-semibold text-sm ${t.textPrimary}`} numberOfLines={1}>
                        {req.display_name}
                      </Text>
                      <Text className={`text-xs ${t.textTertiary}`} numberOfLines={1}>
                        {req.email}
                      </Text>
                    </View>
                    <View className="flex-row gap-2">
                      <TouchableOpacity
                        className="px-3 py-1.5 rounded-xl bg-green-700"
                        onPress={() => handleJoinRequestMutation.mutate({ userId: req.user_id, approve: true })}
                        disabled={handleJoinRequestMutation.isPending}
                      >
                        <Text className="text-xs font-semibold text-white">Approve</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        className={`px-3 py-1.5 rounded-xl border ${t.border}`}
                        onPress={() => handleJoinRequestMutation.mutate({ userId: req.user_id, approve: false })}
                        disabled={handleJoinRequestMutation.isPending}
                      >
                        <Text className={`text-xs font-semibold ${t.textSecondary}`}>Deny</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

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
          behavior={Platform.OS === "ios" ? "padding" : "height"}
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

              <View className="mb-4">
                <DateInput
                  label="End Date"
                  optional
                  value={editEndDate}
                  onChange={setEditEndDate}
                  disabled={updateEventMutation.isPending}
                  returnKeyType="next"
                />
              </View>

              {/* Handicap allowance — leave blank to remove (full handicap) */}
              <View className="mb-4">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                  Handicap Allowance{" "}
                  <Text className={`normal-case font-normal ${t.textTertiary}`}>(optional, 0–100%)</Text>
                </Text>
                <TextInput
                  className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                  placeholder="e.g. 90  (leave blank for full handicap)"
                  placeholderTextColor={t.colors.tabBarInactive}
                  value={editHandicapAllowance}
                  onChangeText={setEditHandicapAllowance}
                  keyboardType="numeric"
                  returnKeyType="done"
                  editable={!updateEventMutation.isPending}
                />
              </View>

              {/* Public event toggle */}
              <View className={`${t.surface} rounded-2xl border ${t.border} overflow-hidden mb-8`}>
                <View className="flex-row items-center justify-between px-4 py-3">
                  <View className="flex-1 mr-4">
                    <Text className={`text-sm ${t.textPrimary}`}>Public event</Text>
                    <Text className={`text-xs mt-0.5 ${t.textTertiary}`}>
                      {editIsPublic
                        ? "Anyone can discover and request to join"
                        : "Invite-only — only members you add can join"}
                    </Text>
                  </View>
                  <Switch
                    value={editIsPublic}
                    onValueChange={setEditIsPublic}
                    trackColor={{ false: "#d1d5db", true: t.colors.tabBarActive }}
                    thumbColor="#ffffff"
                    disabled={updateEventMutation.isPending}
                  />
                </View>
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
                  Delete is inside the Edit modal so it requires a deliberate
                  two-tap gesture, preventing accidental triggers. */}
              <View className={`mt-6 pt-6 border-t ${t.divider} gap-3`}>

                {/* Delete Event — permanently removes the event and all its data. */}
                <TouchableOpacity
                  className="rounded-xl py-4 items-center bg-red-50 border border-red-200"
                  onPress={handleDeleteEvent}
                  disabled={deleteEventMutation.isPending}
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
          roundForm.resetForm();
          setRoundDate("");
          setGroupCount(1);
          setGroupTeeTimes([""]);
        }}
      >
        <KeyboardAvoidingView
          className={`flex-1 ${t.surface}`}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <ScrollView>
            <View className="px-5 pt-8 pb-10">

              <ModalHeader
                title="Schedule Round"
                onClose={() => {
                  setScheduleRoundModalVisible(false);
                  setRoundName("");
                  roundForm.resetForm();
                  setRoundDate("");
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

              {/* ── Course, tee, nine-hole, scoring format ───────────────────── */}
              <RoundFormFields
                selectedCourse={roundForm.selectedCourse}
                selectedTeeId={roundForm.selectedTeeId}
                nineHoleSelection={roundForm.nineHoleSelection}
                scoringFormat={roundForm.scoringFormat}
                vegasBirdieFlip={roundForm.vegasBirdieFlip}
                vegasScoringBasis={roundForm.vegasScoringBasis}
                bestBallScoringBasis={roundForm.bestBallScoringBasis}
                isPending={scheduleRoundMutation.isPending}
                onOpenCoursePicker={() => roundForm.setCoursePickerVisible(true)}
                onClearCourse={() => { roundForm.setSelectedCourse(null); roundForm.setSelectedTeeId(null); }}
                onSelectTee={roundForm.setSelectedTeeId}
                onChangeNineHoles={roundForm.setNineHoleSelection}
                onChangeScoringFormat={roundForm.setScoringFormat}
                onChangeVegasBirdieFlip={roundForm.setVegasBirdieFlip}
                onChangeVegasScoringBasis={roundForm.setVegasScoringBasis}
                onChangeBestBallScoringBasis={roundForm.setBestBallScoringBasis}
              />

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

                {/* One tee time row per group — TimeInput handles the native picker
                    (iOS/Android) and the browser-native <input type="time"> on web. */}
                <View className="gap-2">
                  {Array.from({ length: groupCount }, (_, i) => (
                    <View key={i} className="flex-row items-center gap-3">
                      <Text className={`text-sm font-semibold w-16 ${t.textSecondary}`}>
                        Group {i + 1}
                      </Text>

                      <View className="flex-1">
                        <TimeInput
                          value={groupTeeTimes[i] ?? ""}
                          onChange={(v) => {
                            const updated = [...groupTeeTimes];
                            updated[i] = v;
                            setGroupTeeTimes(updated);
                          }}
                          pickerTitle={`Group ${i + 1} Tee Time`}
                          disabled={scheduleRoundMutation.isPending}
                        />
                      </View>
                    </View>
                  ))}
                </View>
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

      {/* ── Course Picker Modal ─────────────────────────────────────────────── */}
      {/* Rendered outside the Schedule Round modal so it layers correctly on Android. */}
      <CoursePickerModal
        visible={roundForm.coursePickerVisible}
        onClose={() => roundForm.setCoursePickerVisible(false)}
        onSelect={(course) => {
          roundForm.setSelectedCourse(course);
          roundForm.setSelectedTeeId(null);
          roundForm.setNineHoleSelection("18");
          roundForm.setCoursePickerVisible(false);
        }}
      />

    </View>
  );
}
