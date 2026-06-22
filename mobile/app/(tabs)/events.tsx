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
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  RefreshControl,
  Switch,
} from "react-native";

import { useAuth } from "@/hooks/useAuth";
import { useMe } from "@/hooks/useMe";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter, useFocusEffect } from "expo-router";
import { API_URL } from "@/constants/api";
import { apiFetch } from "@/utils/api";
import { savePost } from "@/utils/savePost";
import { showAlert } from "@/utils/alerts";
import DateInput, { apiToDisplay, displayToApi } from "@/components/DateInput";
import { useTheme } from "@/hooks/useTheme";
import { EventTypeBadge, StatusChip } from "@/components/badges";
import FilterSortBar from "@/components/FilterSortBar";
import FilterSheet from "@/components/FilterSheet";
import SortSheet from "@/components/SortSheet";
import { useListPrefsStore } from "@/stores/listPrefsStore";
import {
  filterEvents,
  sortEvents,
  type EventTypeFilter as TypeFilter,
  type EventStatusFilter as StatusFilter,
  type EventSortKey as SortKey,
} from "@/utils/eventFilters";

// ─── Types ────────────────────────────────────────────────────────────────────

type EventResponse = {
  id: string;
  name: string;
  description: string | null;
  event_type: "league" | "tournament" | "casual";
  status: string;
  start_date: string | null; // "YYYY-MM-DD" or null
  end_date: string | null;
  handicap_allowance: number | null; // 0–100, null = full handicap
  is_public: boolean;
  creator_name: string;
  member_count: number;
  created_at: string;
};

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
  const { data: me } = useMe();
  const router = useRouter();
  const t = useTheme();
  const queryClient = useQueryClient();

  // Filter / sort selection is persisted across sessions in the shared list-prefs
  // store (defaults: type "all", status "active", sort by start date ascending).
  const { typeFilter, statusFilter, sortKey } = useListPrefsStore((s) => s.events);
  const setEventPrefs = useListPrefsStore((s) => s.setEventPrefs);
  const resetEventFilters = useListPrefsStore((s) => s.resetEventFilters);
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
  // Handicap allowance stored as a display string (e.g. "90"); converted to number on submit.
  const [newHandicapAllowance, setNewHandicapAllowance] = useState("");
  const [newIsPublic, setNewIsPublic] = useState(false);

  // When start date is picked, pre-fill end date if it's still empty (saves a tap for single-day events).
  const handleStartDateChange = (value: string) => {
    setNewStartDate(value);
    if (!newEndDate) {
      setNewEndDate(value);
    }
  };

  const canCreate = !!me; // any authenticated user can create events

  const { data: events, isLoading, isError, refetch } = useQuery<EventResponse[]>({
    queryKey: ["events"],
    queryFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/events`, {
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

  // Filter and sort client-side — no extra API calls needed. The logic lives in
  // utils/eventFilters.ts (pure + unit-tested) so it counts toward coverage.
  const displayedEvents = useMemo(
    () => (events ? sortEvents(filterEvents(events, typeFilter, statusFilter), sortKey) : []),
    [events, typeFilter, statusFilter, sortKey],
  );

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
      is_public?: boolean;
      handicap_allowance?: number;
    }) => {
      const token = await getToken();
      // savePost: stable Idempotency-Key + retry; the backend durable idempotency store
      // replays the original response so a cellular phantom (commit + lost ack) retry
      // can't create a second event.
      return savePost({
        url: `${API_URL}/api/v1/events`,
        token: token ?? "",
        body: data,
        label: "event",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["events"] });
      setModalVisible(false);
      setNewName("");
      setNewDescription("");
      setNewEventType("league");
      setNewStartDate("");
      setNewEndDate("");
      setNewHandicapAllowance("");
      setNewIsPublic(false);
    },
    onError: (err: Error) => {
      showAlert("Something went wrong", err.message);
    },
  });

  const handleCreate = () => {
    const trimmedName = newName.trim();
    if (!trimmedName) {
      showAlert("Name required", "Please enter a name for the event.");
      return;
    }
    // displayToApi returns "" for empty — use || undefined to omit the field rather than
    // sending an empty string that the backend would try to parse.
    const startDate = displayToApi(newStartDate.trim()) || undefined;
    const endDate   = displayToApi(newEndDate.trim())   || undefined;
    const allowanceStr = newHandicapAllowance.trim();
    const allowanceNum = allowanceStr ? parseFloat(allowanceStr) : undefined;
    if (allowanceNum !== undefined && (isNaN(allowanceNum) || allowanceNum < 0 || allowanceNum > 100)) {
      showAlert("Invalid allowance", "Handicap allowance must be a number between 0 and 100.");
      return;
    }
    createEventMutation.mutate({
      name: trimmedName,
      event_type: newEventType,
      description: newDescription.trim() || undefined,
      start_date: startDate,
      end_date:   endDate,
      handicap_allowance: allowanceNum,
      is_public: newIsPublic,
    });
  };

  const closeModal = () => {
    setModalVisible(false);
    setNewName("");
    setNewDescription("");
    setNewEventType("league");
    setNewStartDate("");
    setNewEndDate("");
    setNewHandicapAllowance("");
    setNewIsPublic(false);
  };

  // Resets the filter axes to their defaults (type "all", status "active") while
  // keeping the chosen sort — handled by the shared store.
  const clearFilters = resetEventFilters;

  // --- Render ---
  return (
    <View className={`flex-1 ${t.screen}`}>
      <View className="pt-14 flex-1">

        {/* Page header */}
        <View className="px-5 flex-row items-center justify-between mb-3">
          <Text className={`text-2xl font-bold ${t.textPrimary}`}>Events</Text>
          <View className="flex-row items-center gap-2">
            <TouchableOpacity
              className={`border ${t.border} rounded-xl px-3 py-2 flex-row items-center gap-1.5`}
              onPress={() => router.push("/events/public")}
            >
              <Ionicons name="globe-outline" size={15} color={t.colors.tabBarInactive} />
              <Text className={`text-xs font-semibold ${t.textSecondary}`}>Discover</Text>
            </TouchableOpacity>
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
        </View>

        {/* Filter + Sort bar — shared with the Rounds screen */}
        <FilterSortBar
          hasActiveFilters={hasActiveFilters}
          sortLabel={currentSortShortLabel}
          onOpenFilter={() => setFilterModalVisible(true)}
          onOpenSort={() => setSortModalVisible(true)}
        />

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

      {/* ── Filter + Sort sheets (shared with the Rounds screen) ─────────────── */}
      <FilterSheet
        visible={filterModalVisible}
        onClose={() => setFilterModalVisible(false)}
        showClearIcon={hasActiveFilters}
        onClearAll={clearFilters}
        sections={[
          {
            key: "type",
            title: "Event Type",
            options: TYPE_FILTER_OPTIONS,
            selected: typeFilter,
            onSelect: (value) => setEventPrefs({ typeFilter: value as TypeFilter }),
          },
          {
            key: "status",
            title: "Status",
            options: STATUS_FILTER_OPTIONS,
            selected: statusFilter,
            onSelect: (value) => setEventPrefs({ statusFilter: value as StatusFilter }),
          },
        ]}
      />

      <SortSheet
        visible={sortModalVisible}
        onClose={() => setSortModalVisible(false)}
        options={SORT_OPTIONS}
        selected={sortKey}
        onSelect={(value) => {
          setEventPrefs({ sortKey: value as SortKey });
          setSortModalVisible(false);
        }}
      />

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

              <View className="mb-4">
                <DateInput
                  label="End Date"
                  optional
                  value={newEndDate}
                  onChange={setNewEndDate}
                  disabled={createEventMutation.isPending}
                  returnKeyType="next"
                />
              </View>

              {/* Handicap allowance — percentage of each player's course handicap applied to net scores */}
              <View className="mb-4">
                <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                  Handicap Allowance{" "}
                  <Text className={`normal-case font-normal ${t.textTertiary}`}>(optional, 0–100%)</Text>
                </Text>
                <TextInput
                  className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                  placeholder="e.g. 90  (leave blank for full handicap)"
                  placeholderTextColor={t.colors.tabBarInactive}
                  value={newHandicapAllowance}
                  onChangeText={setNewHandicapAllowance}
                  keyboardType="numeric"
                  returnKeyType="done"
                  editable={!createEventMutation.isPending}
                />
              </View>

              {/* Public event toggle — public events are discoverable by anyone */}
              <View className={`${t.surface} rounded-2xl border ${t.border} overflow-hidden mb-8`}>
                <View className="flex-row items-center justify-between px-4 py-3">
                  <View className="flex-1 mr-4">
                    <Text className={`text-sm ${t.textPrimary}`}>Public event</Text>
                    <Text className={`text-xs mt-0.5 ${t.textTertiary}`}>
                      {newIsPublic
                        ? "Anyone can discover and request to join"
                        : "Invite-only — only members you add can join"}
                    </Text>
                  </View>
                  <Switch
                    value={newIsPublic}
                    onValueChange={setNewIsPublic}
                    trackColor={{ false: "#d1d5db", true: t.colors.tabBarActive }}
                    thumbColor="#ffffff"
                    disabled={createEventMutation.isPending}
                  />
                </View>
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
