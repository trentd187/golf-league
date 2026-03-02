// app/(tabs)/events.tsx
// The Events screen — shows all events (leagues and tournaments) the user belongs to,
// and lets admin/manager users create a new event.
//
// An "event" is the top-level container for any golf competition:
//   - "league"     — an ongoing, multi-round season with accumulated standings
//   - "tournament" — a one-off competitive event (1 or more rounds)
//   - "casual"     — informal round with friends; no standings or points
//
// Data flow:
//   - useQuery fetches events from GET /api/v1/events on mount and when invalidated
//   - useMutation posts to POST /api/v1/events when the create form is submitted
//   - After a successful create, the query is invalidated so the list refreshes automatically
//   - Filtering and sorting are done client-side on the cached data (no extra API calls)
//
// Auth:
//   - Every request includes the Clerk JWT in the Authorization header via getToken()
//   - The create button is only shown to admin and manager users (checked via user.publicMetadata)

import { useState, useMemo, useCallback } from "react";
import {
  Text,
  View,
  FlatList,
  TouchableOpacity,
  Modal,
  TextInput,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";

// useAuth: provides getToken() to get the current Clerk JWT for API calls
// useUser: provides the user object (to check role for showing the create button)
import { useAuth, useUser } from "@clerk/clerk-expo";

// TanStack Query hooks for data fetching and mutations
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import Ionicons from "@expo/vector-icons/Ionicons";

// useRouter gives us router.push() to navigate to the event detail screen.
// useFocusEffect runs a callback every time this screen gains focus — we use it to
// refetch the events list so edits made on the detail screen are immediately visible
// when the user navigates back. (react-native-screens freezes the tab while a stack
// screen sits on top, so the background refetch from invalidateQueries may not cause
// a re-render on its own.)
import { useRouter, useFocusEffect } from "expo-router";

// API_URL is read from the EXPO_PUBLIC_API_URL environment variable
import { API_URL } from "@/constants/api";
// DateInput: auto-formatted MM-DD-YY text field with native calendar picker.
// apiToDisplay converts YYYY-MM-DD → MM-DD-YY for displaying API dates on cards.
// displayToApi converts MM-DD-YY → YYYY-MM-DD before sending to the backend.
import DateInput, { apiToDisplay, displayToApi } from "@/components/DateInput";

// useTheme gives us the active theme's class strings and hex colors.
import { useTheme } from "@/hooks/useTheme";

// ─── Types ────────────────────────────────────────────────────────────────────

// EventResponse matches the JSON shape returned by GET /api/v1/events
type EventResponse = {
  id: string;
  name: string;
  description: string | null;
  event_type: "league" | "tournament" | "casual"; // what kind of competition
  status: string;
  start_date: string | null; // "YYYY-MM-DD" or null
  end_date: string | null;   // "YYYY-MM-DD" or null
  creator_name: string;
  member_count: number;
  created_at: string;
};

// TypeFilter: which event type to show. "all" shows every type.
type TypeFilter = "all" | EventResponse["event_type"];

// StatusFilter: which lifecycle status to show. "all" shows every status.
type StatusFilter = "all" | "upcoming" | "active" | "completed" | "cancelled";

// SortKey: how to order the list.
type SortKey =
  | "start_date_asc"   // soonest start date first (default)
  | "start_date_desc"  // latest start date first
  | "name_asc"         // alphabetical
  | "members_desc"     // most members first
  | "created_desc";    // most recently created first

// ─── Constants ────────────────────────────────────────────────────────────────

// The three event types available when creating an event
const EVENT_TYPES: { value: EventResponse["event_type"]; label: string }[] = [
  { value: "league",     label: "League" },
  { value: "tournament", label: "Tournament" },
  { value: "casual",     label: "Casual" },
];

// Type filter options shown in the filter bar (includes "All" at the front)
const TYPE_FILTER_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: "all",        label: "All Types" },
  { value: "league",     label: "League" },
  { value: "tournament", label: "Tournament" },
  { value: "casual",     label: "Casual" },
];

// Status filter options shown in the filter bar
const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all",       label: "All Status" },
  { value: "upcoming",  label: "Upcoming" },
  { value: "active",    label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

// Sort options shown in the sort modal.
// shortLabel is shown on the sort button; label is shown inside the modal list.
const SORT_OPTIONS: { value: SortKey; label: string; shortLabel: string }[] = [
  { value: "start_date_asc",  label: "Start Date (earliest first)", shortLabel: "Date ↑" },
  { value: "start_date_desc", label: "Start Date (latest first)",   shortLabel: "Date ↓" },
  { value: "name_asc",        label: "Name (A–Z)",                  shortLabel: "A–Z" },
  { value: "members_desc",    label: "Most Members",                shortLabel: "Members" },
  { value: "created_desc",    label: "Newest First",                shortLabel: "Newest" },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

// EventTypeBadge renders a small coloured pill showing the event type.
// This lets users quickly distinguish leagues from tournaments in the list.
function EventTypeBadge({ type }: { type: EventResponse["event_type"] }) {
  const styles: Record<EventResponse["event_type"], { bg: string; text: string }> = {
    league:     { bg: "bg-blue-100",  text: "text-blue-700" },
    tournament: { bg: "bg-amber-100", text: "text-amber-700" },
    casual:     { bg: "bg-gray-100",  text: "text-gray-600" },
  };
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  const s = styles[type];
  return (
    <View className={`self-start rounded-full px-2 py-0.5 ${s.bg}`}>
      <Text className={`text-xs font-semibold ${s.text}`}>{label}</Text>
    </View>
  );
}

// EventCard renders a single event row in the list.
// onPress navigates to the event detail screen — the card is fully tappable.
function EventCard({ event, onPress }: { event: EventResponse; onPress: () => void }) {
  // Read the active theme so card colors respond to theme switches.
  const t = useTheme();

  return (
    // t.surface: themed card background | t.border: themed card border
    <TouchableOpacity
      className={`${t.surface} rounded-2xl p-4 mb-3 border ${t.border}`}
      onPress={onPress}
      activeOpacity={0.75}
    >
      {/* Event name + type badge on the same row */}
      <View className="flex-row items-center justify-between mb-1">
        <Text className={`font-semibold text-base flex-1 mr-2 ${t.textPrimary}`} numberOfLines={1}>
          {event.name}
        </Text>
        {/* EventTypeBadge uses categorical colors — not themed */}
        <EventTypeBadge type={event.event_type} />
      </View>

      {/* Optional description */}
      {event.description ? (
        <Text className={`text-sm mb-2 ${t.textSecondary}`} numberOfLines={2}>
          {event.description}
        </Text>
      ) : null}

      {/* Date range — shown when at least one date is set.
          Dates come from the API as YYYY-MM-DD; apiToDisplay converts to MM-DD-YY. */}
      {(event.start_date || event.end_date) && (
        <View className="flex-row items-center gap-1 mb-2">
          <Ionicons name="calendar-outline" size={12} color={t.colors.tabBarInactive} />
          <Text className={`text-xs ${t.textTertiary}`}>
            {event.start_date ? apiToDisplay(event.start_date) : "—"}
            {event.end_date ? ` → ${apiToDisplay(event.end_date)}` : ""}
          </Text>
        </View>
      )}

      {/* Footer: creator + member count + chevron indicating tappability */}
      <View className="flex-row items-center justify-between mt-1">
        <Text className={`text-xs ${t.textTertiary}`}>Created by {event.creator_name}</Text>
        <View className="flex-row items-center gap-2">
          <View className="flex-row items-center gap-1">
            <Ionicons name="people-outline" size={13} color={t.colors.tabBarInactive} />
            <Text className={`text-xs ${t.textTertiary}`}>{event.member_count}</Text>
          </View>
          <Ionicons name="chevron-forward-outline" size={14} color={t.colors.tabBarInactive} />
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function EventsScreen() {
  // getToken(): async — returns the current Clerk session JWT for Authorization headers
  const { getToken } = useAuth();
  const { user } = useUser();

  // router.push() navigates to a new screen, pushing it onto the navigation stack
  const router = useRouter();

  // t: the active theme — drives background, surface, and text colors throughout this screen
  const t = useTheme();

  // queryClient lets us manually invalidate cached data (force a refetch after mutations)
  const queryClient = useQueryClient();

  // --- Filter / sort state ---
  const [typeFilter,   setTypeFilter]   = useState<TypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // Default sort: start date ascending (soonest event first)
  const [sortKey,      setSortKey]      = useState<SortKey>("start_date_asc");
  // Controls the sort picker bottom sheet
  const [sortModalVisible,   setSortModalVisible]   = useState(false);
  // Controls the filter options bottom sheet
  const [filterModalVisible, setFilterModalVisible] = useState(false);

  // --- Create event modal state ---
  const [modalVisible, setModalVisible] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  // newEventType: which type of event the user is creating; defaults to "league"
  const [newEventType, setNewEventType] = useState<EventResponse["event_type"]>("league");
  // Dates stored in MM-DD-YY display format; converted to YYYY-MM-DD when sent to the API
  const [newStartDate, setNewStartDate] = useState("");
  const [newEndDate, setNewEndDate] = useState("");

  // handleStartDateChange: when a start date is chosen, also set the end date to match
  // if the end date hasn't been filled in yet. This saves a tap for single-day events
  // or gives a sensible starting point for multi-day ranges.
  const handleStartDateChange = (value: string) => {
    setNewStartDate(value);
    if (!newEndDate) {
      setNewEndDate(value);
    }
  };

  // --- Check user's role from Clerk publicMetadata ---
  // publicMetadata is typed as Record<string, unknown> so we cast it.
  // The role was set via the Clerk dashboard and included in the JWT template.
  const userRole = (user?.publicMetadata as { role?: string })?.role ?? "user";
  // Only admin and manager users can create events
  const canCreate = userRole === "admin" || userRole === "manager";

  // --- Fetch events ---
  // useQuery fetches on mount, caches the result, and refetches when its cache key is invalidated.
  const { data: events, isLoading, isError, refetch } = useQuery<EventResponse[]>({
    queryKey: ["events"],
    queryFn: async () => {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/events`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to fetch events: ${res.status}`);
      return res.json();
    },
  });

  // When this tab gains focus, check whether the events query was explicitly invalidated
  // (e.g., by updateEventMutation.onSuccess on the detail screen) and refetch only then.
  //
  // Why not always refetch on focus?
  //   react-native-screens freezes the tab while a stack screen is on top. When the user
  //   navigates back, the frozen component unfreezes but may not have re-rendered with the
  //   background refetch result. Checking isInvalidated targets exactly that case —
  //   a mutation happened and we need fresh data — without firing a network request every
  //   time the user simply switches tabs or navigates back from an unrelated screen.
  useFocusEffect(
    useCallback(() => {
      // getQueryState returns the current cache entry's metadata.
      // isInvalidated is set to true by invalidateQueries() and reset to false after a
      // successful refetch, so this fires at most once per invalidation.
      const state = queryClient.getQueryState(["events"]);
      if (state?.isInvalidated) {
        refetch();
      }
    }, [queryClient, refetch])
  );

  // --- Filter + sort logic ---
  // useMemo recomputes displayedEvents only when the raw data or filter/sort settings change.
  // All filtering and sorting is client-side — no extra API calls needed.
  const displayedEvents = useMemo(() => {
    if (!events) return [];

    // Step 1: Filter by type
    let result = typeFilter === "all"
      ? events
      : events.filter((e) => e.event_type === typeFilter);

    // Step 2: Filter by status
    if (statusFilter !== "all") {
      result = result.filter((e) => e.status === statusFilter);
    }

    // Step 3: Sort. We spread into a new array first because Array.sort() mutates in place,
    // and we don't want to mutate the cached data from React Query.
    const sorted = [...result];

    switch (sortKey) {
      case "start_date_asc":
        // Soonest date first; events with no start_date go to the end
        sorted.sort((a, b) => {
          if (!a.start_date && !b.start_date) return 0;
          if (!a.start_date) return 1;  // nulls last
          if (!b.start_date) return -1;
          return a.start_date.localeCompare(b.start_date);
        });
        break;

      case "start_date_desc":
        // Latest date first; events with no start_date go to the end
        sorted.sort((a, b) => {
          if (!a.start_date && !b.start_date) return 0;
          if (!a.start_date) return 1;  // nulls last even when descending
          if (!b.start_date) return -1;
          return b.start_date.localeCompare(a.start_date);
        });
        break;

      case "name_asc":
        // Alphabetical by event name (case-insensitive)
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;

      case "members_desc":
        // Most members first
        sorted.sort((a, b) => b.member_count - a.member_count);
        break;

      case "created_desc":
        // Most recently created first.
        // ISO strings ("2026-03-01T...") compare correctly as strings.
        sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
        break;
    }

    return sorted;
  }, [events, typeFilter, statusFilter, sortKey]);

  // Whether any filter is currently active (not "all") — used to show a "Clear" link
  const hasActiveFilters = typeFilter !== "all" || statusFilter !== "all";

  // The short label for the current sort shown on the sort button
  const currentSortShortLabel =
    SORT_OPTIONS.find((o) => o.value === sortKey)?.shortLabel ?? "Sort";

  // --- Create event mutation ---
  // useMutation wraps the POST request. On success it invalidates the events query
  // so the list automatically refreshes to include the newly created event.
  const createEventMutation = useMutation({
    mutationFn: async (data: {
      name: string;
      event_type: string;
      description?: string;
      start_date?: string; // YYYY-MM-DD, or omitted to leave unset
      end_date?: string;
    }) => {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        // Try to extract the error message from the response body
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      // Invalidate the events cache — React Query will refetch in the background
      queryClient.invalidateQueries({ queryKey: ["events"] });
      setModalVisible(false);
      setNewName("");
      setNewDescription("");
      setNewEventType("league");
      setNewStartDate("");
      setNewEndDate("");
    },
    onError: (err: Error) => {
      Alert.alert("Something went wrong", err.message, [{ text: "OK" }]);
    },
  });

  const handleCreate = () => {
    const trimmedName = newName.trim();
    if (!trimmedName) {
      Alert.alert("Name required", "Please enter a name for the event.", [{ text: "OK" }]);
      return;
    }
    // Convert dates from MM-DD-YY display format to YYYY-MM-DD for the API.
    // displayToApi returns "" for empty — we use || undefined to omit the field entirely
    // rather than sending an empty string, which the backend would try to parse.
    const startDate = displayToApi(newStartDate.trim()) || undefined;
    const endDate   = displayToApi(newEndDate.trim())   || undefined;
    createEventMutation.mutate({
      name: trimmedName,
      event_type: newEventType,
      description: newDescription.trim() || undefined,
      start_date: startDate,
      end_date:   endDate,
    });
  };

  const closeModal = () => {
    setModalVisible(false);
    setNewName("");
    setNewDescription("");
    setNewEventType("league");
    setNewStartDate("");
    setNewEndDate("");
  };

  const clearFilters = () => {
    setTypeFilter("all");
    setStatusFilter("all");
  };

  // --- Render ---
  return (
    // t.screen: full-page background
    <View className={`flex-1 ${t.screen}`}>
      <View className="pt-14 flex-1">

        {/* ── Page header ────────────────────────────────────────────────────── */}
        <View className="px-5 flex-row items-center justify-between mb-3">
          <Text className={`text-2xl font-bold ${t.textPrimary}`}>Events</Text>
          {canCreate && (
            // Create button uses the theme's primary color
            <TouchableOpacity
              className={`${t.primaryBg} rounded-xl px-4 py-2 flex-row items-center gap-2`}
              onPress={() => setModalVisible(true)}
            >
              <Ionicons name="add" size={18} color="white" />
              <Text className="text-white font-semibold text-sm">Create</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── Filter + Sort control bar ───────────────────────────────────────── */}
        {/* Two compact buttons side by side below the header.
            Filter opens a bottom-sheet with all filter checkboxes.
            Sort opens a bottom-sheet with sort order options. */}
        <View className="px-5 flex-row items-center gap-2 mb-4">

          {/* Filter button — turns green when any filter is active to signal state */}
          <TouchableOpacity
            className={`flex-row items-center gap-1.5 border rounded-xl px-3 py-2 ${
              hasActiveFilters
                ? "bg-green-50 border-green-300"  // highlighted state when filters are on
                : "bg-white border-gray-200"       // default state
            }`}
            onPress={() => setFilterModalVisible(true)}
          >
            {/* funnel icon — standard filter icon in mobile UIs */}
            <Ionicons
              name="options-outline"
              size={14}
              color={hasActiveFilters ? "#15803d" : "#6b7280"}
            />
            <Text className={`text-xs font-semibold ${hasActiveFilters ? "text-green-700" : "text-gray-600"}`}>
              {/* Bullet after "Filter" when active so the user sees something is on */}
              Filter{hasActiveFilters ? "  •" : ""}
            </Text>
          </TouchableOpacity>

          {/* Sort button — shows the current sort's short label */}
          <TouchableOpacity
            className="flex-row items-center gap-1.5 border border-gray-200 rounded-xl px-3 py-2 bg-white"
            onPress={() => setSortModalVisible(true)}
          >
            <Ionicons name="swap-vertical-outline" size={14} color="#6b7280" />
            <Text className="text-gray-600 text-xs font-semibold">{currentSortShortLabel}</Text>
          </TouchableOpacity>

        </View>

        {/* ── Content: loading / error / list ────────────────────────────────── */}
        {isLoading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" color={t.colors.tabBarActive} />
          </View>
        ) : isError ? (
          <View className="flex-1 items-center justify-center gap-3">
            <Ionicons name="alert-circle-outline" size={48} color="#dc2626" />
            <Text className={`font-semibold ${t.textPrimary}`}>Failed to load events</Text>
            <TouchableOpacity className={`${t.primaryBg} rounded-xl px-6 py-3`} onPress={() => refetch()}>
              <Text className="text-white font-semibold">Retry</Text>
            </TouchableOpacity>
          </View>
        ) : displayedEvents.length > 0 ? (
          // FlatList only renders visible items — more efficient than ScrollView for long lists
          <FlatList
            data={displayedEvents}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}
            renderItem={({ item }) => (
              // Navigate to /events/[id] — matches app/events/[id].tsx
              <EventCard
                event={item}
                onPress={() => router.push(`/events/${item.id}`)}
              />
            )}
            showsVerticalScrollIndicator={false}
          />
        ) : (
          // Empty state — different message depending on whether filters are hiding results
          <View className="flex-1 items-center justify-center gap-3 px-8">
            <Ionicons name="trophy-outline" size={56} color={t.colors.tabBarActive} />
            {hasActiveFilters ? (
              <>
                <Text className={`text-xl font-semibold ${t.textPrimary}`}>No matching events</Text>
                <Text className={`text-sm text-center ${t.textSecondary}`}>
                  No events match the selected filters.
                </Text>
                <TouchableOpacity
                  className={`${t.primaryBg} rounded-xl px-6 py-3`}
                  onPress={clearFilters}
                >
                  <Text className="text-white font-semibold">Clear Filters</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text className={`text-xl font-semibold ${t.textPrimary}`}>No events yet</Text>
                <Text className={`text-sm text-center ${t.textSecondary}`}>
                  {canCreate
                    ? 'Tap "Create" to set up your first league or tournament.'
                    : "You haven't been added to any events yet."}
                </Text>
              </>
            )}
          </View>
        )}
      </View>

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* ── Filter Modal ───────────────────────────────────────────────────── */}
      {/* ══════════════════════════════════════════════════════════════════════ */}

      {/* Same transparent bottom-sheet pattern as the sort modal.
          Contains two sections (Event Type + Status), each with radio-style rows,
          plus a "Clear All" row at the top to reset both filters at once. */}
      <Modal
        visible={filterModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setFilterModalVisible(false)}
      >
        <View className="flex-1">
          {/* Dim backdrop — tap anywhere outside the sheet to close */}
          <TouchableOpacity
            className="absolute inset-0 bg-black/40"
            activeOpacity={1}
            onPress={() => setFilterModalVisible(false)}
          />

          {/* The filter sheet — anchored to the bottom, themed surface */}
          <View className={`absolute bottom-0 left-0 right-0 ${t.surface} rounded-t-2xl pb-10`}>

            {/* Sheet header row */}
            <View className={`flex-row items-center justify-between px-5 pt-5 pb-3 border-b ${t.divider}`}>
              <Text className={`text-base font-bold ${t.textPrimary}`}>Filter</Text>
              <TouchableOpacity onPress={() => setFilterModalVisible(false)}>
                <Ionicons name="close" size={22} color={t.colors.tabBarInactive} />
              </TouchableOpacity>
            </View>

            {/* Clear All row — resets both type and status to "all" */}
            <TouchableOpacity
              className="flex-row items-center justify-between px-5 py-3 border-b border-gray-100"
              onPress={() => {
                setTypeFilter("all");
                setStatusFilter("all");
              }}
            >
              <Text className="text-sm font-semibold text-red-500">Clear All</Text>
              {/* Only show the trash icon when something is actually active */}
              {hasActiveFilters && (
                <Ionicons name="trash-outline" size={16} color="#ef4444" />
              )}
            </TouchableOpacity>

            {/* ── Event Type section ─────────────────────────────────────── */}
            <View className="px-5 pt-4 pb-2">
              <Text className={`text-xs font-semibold uppercase tracking-widest ${t.textTertiary}`}>
                Event Type
              </Text>
            </View>

            {/* One row per type option.
                "checkmark-circle" (filled with active color) = selected.
                "ellipse-outline" (empty gray) = unselected. */}
            {TYPE_FILTER_OPTIONS.map((opt) => {
              const selected = typeFilter === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  className={`flex-row items-center justify-between px-5 py-3.5 border-b ${t.divider}`}
                  onPress={() => setTypeFilter(opt.value)}
                >
                  <Text
                    className={`text-sm ${selected ? "font-semibold" : ""} ${selected ? t.textPrimary : t.textSecondary}`}
                  >
                    {opt.label}
                  </Text>
                  <Ionicons
                    name={selected ? "checkmark-circle" : "ellipse-outline"}
                    size={20}
                    color={selected ? t.colors.tabBarActive : t.colors.tabBarInactive}
                  />
                </TouchableOpacity>
              );
            })}

            {/* ── Status section ─────────────────────────────────────────── */}
            <View className="px-5 pt-4 pb-2">
              <Text className={`text-xs font-semibold uppercase tracking-widest ${t.textTertiary}`}>
                Status
              </Text>
            </View>

            {STATUS_FILTER_OPTIONS.map((opt) => {
              const selected = statusFilter === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  className={`flex-row items-center justify-between px-5 py-3.5 border-b ${t.divider}`}
                  onPress={() => setStatusFilter(opt.value)}
                >
                  <Text
                    className={`text-sm ${selected ? "font-semibold" : ""} ${selected ? t.textPrimary : t.textSecondary}`}
                  >
                    {opt.label}
                  </Text>
                  <Ionicons
                    name={selected ? "checkmark-circle" : "ellipse-outline"}
                    size={20}
                    color={selected ? t.colors.tabBarActive : t.colors.tabBarInactive}
                  />
                </TouchableOpacity>
              );
            })}

          </View>
        </View>
      </Modal>

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* ── Sort Modal ─────────────────────────────────────────────────────── */}
      {/* ══════════════════════════════════════════════════════════════════════ */}

      {/* transparent + animationType="slide": bottom sheet slides up over a dim backdrop */}
      <Modal
        visible={sortModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setSortModalVisible(false)}
      >
        <View className="flex-1">
          {/* Tapping the backdrop dismisses the sheet */}
          <TouchableOpacity
            className="absolute inset-0 bg-black/40"
            activeOpacity={1}
            onPress={() => setSortModalVisible(false)}
          />

          {/* The sort sheet — anchored to the bottom of the screen, themed surface */}
          <View className={`absolute bottom-0 left-0 right-0 ${t.surface} rounded-t-2xl pb-8`}>

            {/* Sheet header */}
            <View className={`flex-row items-center justify-between px-5 pt-5 pb-3 border-b ${t.divider}`}>
              <Text className={`text-base font-bold ${t.textPrimary}`}>Sort By</Text>
              <TouchableOpacity onPress={() => setSortModalVisible(false)}>
                <Ionicons name="close" size={22} color={t.colors.tabBarInactive} />
              </TouchableOpacity>
            </View>

            {/* Sort option rows — tapping one selects it and closes the sheet */}
            {SORT_OPTIONS.map((opt) => {
              const selected = sortKey === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  className={`flex-row items-center justify-between px-5 py-4 border-b ${t.divider}`}
                  onPress={() => {
                    setSortKey(opt.value);
                    setSortModalVisible(false);
                  }}
                >
                  {/* Selected option uses primary text; others use secondary */}
                  <Text
                    className={`text-base ${
                      selected ? `font-semibold ${t.textPrimary}` : t.textSecondary
                    }`}
                  >
                    {opt.label}
                  </Text>
                  {/* Checkmark next to the active selection */}
                  {selected && (
                    <Ionicons name="checkmark" size={18} color={t.colors.tabBarActive} />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </Modal>

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* ── Create Event Modal ─────────────────────────────────────────────── */}
      {/* ══════════════════════════════════════════════════════════════════════ */}

      {/* animationType="slide" gives the native bottom-sheet feel */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closeModal}
      >
        {/* KeyboardAvoidingView lifts the form above the keyboard when it opens */}
        <KeyboardAvoidingView
          className={`flex-1 ${t.surface}`}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView>
            <View className="px-5 pt-8 pb-10">

              {/* Modal header */}
              <View className="flex-row items-center justify-between mb-8">
                <Text className={`text-xl font-bold ${t.textPrimary}`}>Create Event</Text>
                <TouchableOpacity
                  onPress={closeModal}
                  disabled={createEventMutation.isPending}
                >
                  <Ionicons name="close" size={24} color={t.colors.tabBarInactive} />
                </TouchableOpacity>
              </View>

              {/* Event type selector — three pill buttons: League / Tournament / Casual */}
              <View className="mb-6">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                  Type <Text className="text-red-500">*</Text>
                </Text>
                {/* flex-row with gap — each pill takes equal width via flex-1 */}
                <View className="flex-row gap-2">
                  {EVENT_TYPES.map((et) => {
                    const selected = newEventType === et.value;
                    return (
                      <TouchableOpacity
                        key={et.value}
                        // selected: themed primary background; unselected: surface with input border
                        className={`flex-1 rounded-xl py-3 items-center border ${
                          selected
                            ? `${t.primaryBg} border-transparent`
                            : `${t.surface} ${t.borderInput}`
                        }`}
                        onPress={() => setNewEventType(et.value)}
                        disabled={createEventMutation.isPending}
                      >
                        <Text
                          className={`text-sm font-semibold ${
                            selected ? "text-white" : t.textSecondary
                          }`}
                        >
                          {et.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Event name (required) */}
              <View className="mb-4">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                  Name <Text className="text-red-500">*</Text>
                </Text>
                <TextInput
                  className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                  placeholder={
                    newEventType === "league"
                      ? "e.g. Saturday Morning League"
                      : newEventType === "tournament"
                      ? "e.g. Club Championship 2025"
                      : "e.g. Sunday Scramble"
                  }
                  placeholderTextColor={t.colors.tabBarInactive}
                  value={newName}
                  onChangeText={setNewName}
                  autoCapitalize="words"
                  editable={!createEventMutation.isPending}
                  returnKeyType="next"
                />
              </View>

              {/* Description (optional) */}
              <View className="mb-4">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                  Description{" "}
                  <Text className={`normal-case font-normal ${t.textTertiary}`}>(optional)</Text>
                </Text>
                <TextInput
                  className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                  placeholder="A short description..."
                  placeholderTextColor={t.colors.tabBarInactive}
                  value={newDescription}
                  onChangeText={setNewDescription}
                  multiline
                  numberOfLines={3}
                  // textAlignVertical: ensures text starts at the top of the input on Android
                  textAlignVertical="top"
                  editable={!createEventMutation.isPending}
                />
              </View>

              {/* Start date (optional) — setting it auto-fills end date as a convenience */}
              <View className="mb-4">
                <DateInput
                  label="Start Date"
                  optional
                  value={newStartDate}
                  onChange={handleStartDateChange}
                  disabled={createEventMutation.isPending}
                  returnKeyType="next"
                />
              </View>

              {/* End date (optional) — pre-filled from start date, can be changed */}
              <View className="mb-8">
                <DateInput
                  label="End Date"
                  optional
                  value={newEndDate}
                  onChange={setNewEndDate}
                  disabled={createEventMutation.isPending}
                  returnKeyType="done"
                />
              </View>

              {/* Submit button — uses themed primary color */}
              <TouchableOpacity
                className={`rounded-xl py-4 items-center ${
                  createEventMutation.isPending ? t.primaryBgDisabled : t.primaryBg
                }`}
                onPress={handleCreate}
                disabled={createEventMutation.isPending}
              >
                {createEventMutation.isPending ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text className="text-white font-semibold text-base">Create Event</Text>
                )}
              </TouchableOpacity>

            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}
