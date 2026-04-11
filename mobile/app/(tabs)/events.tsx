// app/(tabs)/events.tsx
// The Events screen — shows all events the user belongs to and lets admin/manager
// users create a new event.
//
// Data flow:
//   - useQuery fetches GET /api/v1/events on mount and when invalidated
//   - useMutation posts to POST /api/v1/events on form submit
//   - Filtering and sorting are client-side on the cached data
//
// useFocusEffect refetches only when the query was explicitly invalidated (e.g. after
// an edit on the detail screen) — avoids a network request on every tab switch.

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
  RefreshControl,
} from "react-native";

import { useAuth, useUser } from "@clerk/clerk-expo";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter, useFocusEffect } from "expo-router";
import { API_URL } from "@/constants/api";
import DateInput, { apiToDisplay, displayToApi } from "@/components/DateInput";
import { useTheme } from "@/hooks/useTheme";
import { EventTypeBadge, StatusChip } from "@/components/badges";

// ─── Types ────────────────────────────────────────────────────────────────────

type EventResponse = {
  id: string;
  name: string;
  description: string | null;
  event_type: "league" | "tournament" | "casual";
  status: string;
  start_date: string | null; // "YYYY-MM-DD" or null
  end_date: string | null;
  creator_name: string;
  member_count: number;
  created_at: string;
};

type TypeFilter = "all" | EventResponse["event_type"];

// Only "active" and "completed" are valid event statuses — cancel was removed.
type StatusFilter = "all" | "active" | "completed";

type SortKey =
  | "start_date_asc"
  | "start_date_desc"
  | "name_asc"
  | "members_desc"
  | "created_desc";

// ─── Constants ────────────────────────────────────────────────────────────────

const EVENT_TYPES: { value: EventResponse["event_type"]; label: string }[] = [
  { value: "league",     label: "League" },
  { value: "tournament", label: "Tournament" },
  { value: "casual",     label: "Casual" },
];

const TYPE_FILTER_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: "all",        label: "All Types" },
  { value: "league",     label: "League" },
  { value: "tournament", label: "Tournament" },
  { value: "casual",     label: "Casual" },
];

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all",       label: "All Status" },
  { value: "active",    label: "Active" },
  { value: "completed", label: "Completed" },
];

// shortLabel is shown on the sort button; label is shown inside the sort modal.
const SORT_OPTIONS: { value: SortKey; label: string; shortLabel: string }[] = [
  { value: "start_date_asc",  label: "Start Date (earliest first)", shortLabel: "Date ↑" },
  { value: "start_date_desc", label: "Start Date (latest first)",   shortLabel: "Date ↓" },
  { value: "name_asc",        label: "Name (A–Z)",                  shortLabel: "A–Z" },
  { value: "members_desc",    label: "Most Members",                shortLabel: "Members" },
  { value: "created_desc",    label: "Newest First",                shortLabel: "Newest" },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function EventCard({ event, onPress }: { event: EventResponse; onPress: () => void }) {
  const t = useTheme();

  return (
    <TouchableOpacity
      className={`${t.surface} rounded-2xl p-4 mb-3 border ${t.border}`}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <View className="flex-row items-center justify-between mb-1">
        <Text className={`font-semibold text-base flex-1 mr-2 ${t.textPrimary}`} numberOfLines={1}>
          {event.name}
        </Text>
        <View className="flex-row items-center gap-1.5">
          <StatusChip status={event.status} />
          <EventTypeBadge type={event.event_type} />
        </View>
      </View>

      {event.description ? (
        <Text className={`text-sm mb-2 ${t.textSecondary}`} numberOfLines={2}>
          {event.description}
        </Text>
      ) : null}

      {/* Dates come from the API as YYYY-MM-DD; apiToDisplay converts to MM-DD-YY. */}
      {(event.start_date || event.end_date) && (
        <View className="flex-row items-center gap-1 mb-2">
          <Ionicons name="calendar-outline" size={12} color={t.colors.tabBarInactive} />
          <Text className={`text-xs ${t.textTertiary}`}>
            {event.start_date ? apiToDisplay(event.start_date) : "—"}
            {event.end_date ? ` → ${apiToDisplay(event.end_date)}` : ""}
          </Text>
        </View>
      )}

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
  const { getToken } = useAuth();
  const { user } = useUser();
  const router = useRouter();
  const t = useTheme();
  const queryClient = useQueryClient();

  // Filter / sort state
  const [typeFilter,   setTypeFilter]   = useState<TypeFilter>("all");
  // Default to "active" so the list opens showing only in-progress events.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [sortKey,      setSortKey]      = useState<SortKey>("start_date_asc");
  const [sortModalVisible,   setSortModalVisible]   = useState(false);
  const [filterModalVisible, setFilterModalVisible] = useState(false);

  // Create event modal state
  const [modalVisible, setModalVisible] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newEventType, setNewEventType] = useState<EventResponse["event_type"]>("league");
  // Dates stored in MM-DD-YY display format; converted to YYYY-MM-DD when sent to the API.
  const [newStartDate, setNewStartDate] = useState("");
  const [newEndDate, setNewEndDate] = useState("");

  // When start date is picked, pre-fill end date if it's still empty (saves a tap for single-day events).
  const handleStartDateChange = (value: string) => {
    setNewStartDate(value);
    if (!newEndDate) {
      setNewEndDate(value);
    }
  };

  // publicMetadata is typed as Record<string, unknown> so we cast it.
  const userRole = (user?.publicMetadata as { role?: string })?.role ?? "user";
  const canCreate = userRole === "admin" || userRole === "manager";

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

  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  // Refetch only when the query was explicitly invalidated (e.g. after an edit on the detail screen).
  // react-native-screens freezes the tab while a stack screen is on top; the background refetch
  // from invalidateQueries may not trigger a re-render on its own when the tab unfreezes.
  useFocusEffect(
    useCallback(() => {
      const state = queryClient.getQueryState(["events"]);
      if (state?.isInvalidated) {
        refetch();
      }
    }, [queryClient, refetch])
  );

  // Filter and sort client-side — no extra API calls needed.
  const displayedEvents = useMemo(() => {
    if (!events) return [];

    let result = typeFilter === "all"
      ? events
      : events.filter((e) => e.event_type === typeFilter);

    if (statusFilter !== "all") {
      result = result.filter((e) => e.status === statusFilter);
    }

    // Spread into a new array before sorting — Array.sort() mutates in place and we
    // don't want to mutate the React Query cache.
    const sorted = [...result];

    switch (sortKey) {
      case "start_date_asc":
        sorted.sort((a, b) => {
          if (!a.start_date && !b.start_date) return 0;
          if (!a.start_date) return 1;  // nulls last
          if (!b.start_date) return -1;
          return a.start_date.localeCompare(b.start_date);
        });
        break;

      case "start_date_desc":
        sorted.sort((a, b) => {
          if (!a.start_date && !b.start_date) return 0;
          if (!a.start_date) return 1;  // nulls last even when descending
          if (!b.start_date) return -1;
          return b.start_date.localeCompare(a.start_date);
        });
        break;

      case "name_asc":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;

      case "members_desc":
        sorted.sort((a, b) => b.member_count - a.member_count);
        break;

      case "created_desc":
        // ISO strings compare correctly as strings.
        sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
        break;
    }

    return sorted;
  }, [events, typeFilter, statusFilter, sortKey]);

  // statusFilter defaults to "active", so it counts as active only if changed away from that.
  const hasActiveFilters = typeFilter !== "all" || statusFilter !== "active";

  const currentSortShortLabel =
    SORT_OPTIONS.find((o) => o.value === sortKey)?.shortLabel ?? "Sort";

  const createEventMutation = useMutation({
    mutationFn: async (data: {
      name: string;
      event_type: string;
      description?: string;
      start_date?: string;
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
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
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
    // displayToApi returns "" for empty — use || undefined to omit the field rather than
    // sending an empty string that the backend would try to parse.
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
    setStatusFilter("active");
  };

  // --- Render ---
  return (
    <View className={`flex-1 ${t.screen}`}>
      <View className="pt-14 flex-1">

        {/* Page header */}
        <View className="px-5 flex-row items-center justify-between mb-3">
          <Text className={`text-2xl font-bold ${t.textPrimary}`}>Events</Text>
          {canCreate && (
            <TouchableOpacity
              className={`${t.primaryBg} rounded-xl px-4 py-2 flex-row items-center gap-2`}
              onPress={() => setModalVisible(true)}
            >
              <Ionicons name="add" size={18} color="white" />
              <Text className="text-white font-semibold text-sm">Create</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Filter + Sort bar */}
        <View className="px-5 flex-row items-center gap-2 mb-4">

          {/* Filter button — highlighted when any filter is active */}
          <TouchableOpacity
            className={`flex-row items-center gap-1.5 border rounded-xl px-3 py-2 ${
              hasActiveFilters
                ? "bg-green-50 border-green-300"
                : "bg-white border-gray-200"
            }`}
            onPress={() => setFilterModalVisible(true)}
          >
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

        {/* Content: loading / error / list */}
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
          <FlatList
            data={displayedEvents}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}
            renderItem={({ item }) => (
              <EventCard
                event={item}
                onPress={() => router.push(`/events/${item.id}`)}
              />
            )}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={handleRefresh}
                colors={[t.colors.tabBarActive]}
                tintColor={t.colors.tabBarActive}
              />
            }
          />
        ) : (
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

      {/* ── Filter Modal ─────────────────────────────────────────────────────── */}
      <Modal
        visible={filterModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setFilterModalVisible(false)}
      >
        <View className="flex-1">
          {/* Tap the backdrop to close */}
          <TouchableOpacity
            className="absolute inset-0 bg-black/40"
            activeOpacity={1}
            onPress={() => setFilterModalVisible(false)}
          />

          <View className={`absolute bottom-0 left-0 right-0 ${t.surface} rounded-t-2xl pb-10`}>

            <View className={`flex-row items-center justify-between px-5 pt-5 pb-3 border-b ${t.divider}`}>
              <Text className={`text-base font-bold ${t.textPrimary}`}>Filter</Text>
              <TouchableOpacity onPress={() => setFilterModalVisible(false)}>
                <Ionicons name="close" size={22} color={t.colors.tabBarInactive} />
              </TouchableOpacity>
            </View>

            {/* Clear All — resets type to "all" and status back to the default "active" */}
            <TouchableOpacity
              className="flex-row items-center justify-between px-5 py-3 border-b border-gray-100"
              onPress={() => {
                setTypeFilter("all");
                setStatusFilter("active");
              }}
            >
              <Text className="text-sm font-semibold text-red-500">Clear All</Text>
              {hasActiveFilters && (
                <Ionicons name="trash-outline" size={16} color="#ef4444" />
              )}
            </TouchableOpacity>

            <View className="px-5 pt-4 pb-2">
              <Text className={`text-xs font-semibold uppercase tracking-widest ${t.textTertiary}`}>
                Event Type
              </Text>
            </View>

            {/* "checkmark-circle" = selected; "ellipse-outline" = unselected */}
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

      {/* ── Sort Modal ───────────────────────────────────────────────────────── */}
      <Modal
        visible={sortModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setSortModalVisible(false)}
      >
        <View className="flex-1">
          <TouchableOpacity
            className="absolute inset-0 bg-black/40"
            activeOpacity={1}
            onPress={() => setSortModalVisible(false)}
          />

          <View className={`absolute bottom-0 left-0 right-0 ${t.surface} rounded-t-2xl pb-8`}>

            <View className={`flex-row items-center justify-between px-5 pt-5 pb-3 border-b ${t.divider}`}>
              <Text className={`text-base font-bold ${t.textPrimary}`}>Sort By</Text>
              <TouchableOpacity onPress={() => setSortModalVisible(false)}>
                <Ionicons name="close" size={22} color={t.colors.tabBarInactive} />
              </TouchableOpacity>
            </View>

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
                  <Text
                    className={`text-base ${
                      selected ? `font-semibold ${t.textPrimary}` : t.textSecondary
                    }`}
                  >
                    {opt.label}
                  </Text>
                  {selected && (
                    <Ionicons name="checkmark" size={18} color={t.colors.tabBarActive} />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </Modal>

      {/* ── Create Event Modal ───────────────────────────────────────────────── */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closeModal}
      >
        {/* KeyboardAvoidingView lifts the form above the keyboard when it opens */}
        <KeyboardAvoidingView
          className={`flex-1 ${t.surface}`}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <ScrollView>
            <View className="px-5 pt-8 pb-10">

              <View className="flex-row items-center justify-between mb-8">
                <Text className={`text-xl font-bold ${t.textPrimary}`}>Create Event</Text>
                <TouchableOpacity
                  onPress={closeModal}
                  disabled={createEventMutation.isPending}
                >
                  <Ionicons name="close" size={24} color={t.colors.tabBarInactive} />
                </TouchableOpacity>
              </View>

              {/* Event type selector */}
              <View className="mb-6">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                  Type <Text className="text-red-500">*</Text>
                </Text>
                <View className="flex-row gap-2">
                  {EVENT_TYPES.map((et) => {
                    const selected = newEventType === et.value;
                    return (
                      <TouchableOpacity
                        key={et.value}
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
                  // textAlignVertical ensures text starts at the top on Android
                  textAlignVertical="top"
                  editable={!createEventMutation.isPending}
                />
              </View>

              {/* Start date — setting it auto-fills end date if empty */}
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
