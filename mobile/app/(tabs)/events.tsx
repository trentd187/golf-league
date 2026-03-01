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
//
// Auth:
//   - Every request includes the Clerk JWT in the Authorization header via getToken()
//   - The create button is only shown to admin and manager users (checked via user.publicMetadata)

import { useState } from "react";
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

// API_URL is read from the EXPO_PUBLIC_API_URL environment variable
import { API_URL } from "@/constants/api";

// --- Types ---

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

// The three event types the user can choose when creating an event
const EVENT_TYPES: { value: EventResponse["event_type"]; label: string; icon: string }[] = [
  { value: "league",     label: "League",     icon: "trophy-outline" },
  { value: "tournament", label: "Tournament", icon: "ribbon-outline" },
  { value: "casual",     label: "Casual",     icon: "golf-outline" },
];

// --- Sub-components ---

// EventTypeBadge renders a small coloured pill showing the event type.
// This lets users quickly distinguish leagues from tournaments in the list.
function EventTypeBadge({ type }: { type: EventResponse["event_type"] }) {
  // Map each type to its background + text colours
  const styles: Record<EventResponse["event_type"], { bg: string; text: string }> = {
    league:     { bg: "bg-blue-100",  text: "text-blue-700" },
    tournament: { bg: "bg-amber-100", text: "text-amber-700" },
    casual:     { bg: "bg-gray-100",  text: "text-gray-600" },
  };
  const label = type.charAt(0).toUpperCase() + type.slice(1); // "league" → "League"
  const s = styles[type];
  return (
    <View className={`self-start rounded-full px-2 py-0.5 ${s.bg}`}>
      <Text className={`text-xs font-semibold ${s.text}`}>{label}</Text>
    </View>
  );
}

// EventCard renders a single event row in the list
function EventCard({ event }: { event: EventResponse }) {
  return (
    <View className="bg-white rounded-2xl p-4 mb-3 border border-gray-100">
      {/* Event name + type badge on the same row */}
      <View className="flex-row items-center justify-between mb-1">
        <Text className="text-gray-900 font-semibold text-base flex-1 mr-2" numberOfLines={1}>
          {event.name}
        </Text>
        <EventTypeBadge type={event.event_type} />
      </View>

      {/* Optional description */}
      {event.description ? (
        <Text className="text-gray-500 text-sm mb-2" numberOfLines={2}>
          {event.description}
        </Text>
      ) : null}

      {/* Footer: creator + member count */}
      <View className="flex-row items-center justify-between mt-1">
        <Text className="text-gray-400 text-xs">Created by {event.creator_name}</Text>
        <View className="flex-row items-center gap-1">
          <Ionicons name="people-outline" size={13} color="#9ca3af" />
          <Text className="text-gray-400 text-xs">{event.member_count}</Text>
        </View>
      </View>
    </View>
  );
}

// --- Main screen ---

export default function EventsScreen() {
  // getToken(): async — returns the current Clerk session JWT for Authorization headers
  const { getToken } = useAuth();
  const { user } = useUser();

  // queryClient lets us manually invalidate cached data (force a refetch after mutations)
  const queryClient = useQueryClient();

  // --- Create event modal state ---
  const [modalVisible, setModalVisible] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  // newEventType: which type of event the user is creating; defaults to "league"
  const [newEventType, setNewEventType] = useState<EventResponse["event_type"]>("league");

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

  // --- Create event mutation ---
  // useMutation wraps the POST request. On success it invalidates the events query
  // so the list automatically refreshes to include the newly created event.
  const createEventMutation = useMutation({
    mutationFn: async (data: { name: string; event_type: string; description?: string }) => {
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
    createEventMutation.mutate({
      name: trimmedName,
      event_type: newEventType,
      // Only send description if the user actually typed something
      description: newDescription.trim() || undefined,
    });
  };

  const closeModal = () => {
    setModalVisible(false);
    setNewName("");
    setNewDescription("");
    setNewEventType("league");
  };

  // --- Render ---
  return (
    <View className="flex-1 bg-gray-50">
      <View className="px-5 pt-14 pb-4 flex-1">

        {/* Page header: title + create button */}
        <View className="flex-row items-center justify-between mb-6">
          <Text className="text-2xl font-bold text-gray-900">Events</Text>
          {canCreate && (
            <TouchableOpacity
              className="bg-green-700 rounded-xl px-4 py-2 flex-row items-center gap-2"
              onPress={() => setModalVisible(true)}
            >
              <Ionicons name="add" size={18} color="white" />
              <Text className="text-white font-semibold text-sm">Create</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Content: loading spinner / error state / empty state / event list */}
        {isLoading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" color="#15803d" />
          </View>
        ) : isError ? (
          <View className="flex-1 items-center justify-center gap-3">
            <Ionicons name="alert-circle-outline" size={48} color="#dc2626" />
            <Text className="text-gray-700 font-semibold">Failed to load events</Text>
            <TouchableOpacity className="bg-green-700 rounded-xl px-6 py-3" onPress={() => refetch()}>
              <Text className="text-white font-semibold">Retry</Text>
            </TouchableOpacity>
          </View>
        ) : events && events.length > 0 ? (
          // FlatList only renders visible items — more efficient than ScrollView for long lists
          <FlatList
            data={events}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => <EventCard event={item} />}
            showsVerticalScrollIndicator={false}
          />
        ) : (
          <View className="flex-1 items-center justify-center gap-3">
            <Ionicons name="trophy-outline" size={56} color="#15803d" />
            <Text className="text-xl font-semibold text-gray-800">No events yet</Text>
            <Text className="text-gray-500 text-sm text-center">
              {canCreate
                ? 'Tap "Create" to set up your first league or tournament.'
                : "You haven't been added to any events yet."}
            </Text>
          </View>
        )}
      </View>

      {/* ── Create Event Modal ────────────────────────────────────────────────── */}
      {/* animationType="slide" gives the native bottom-sheet feel */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closeModal}
      >
        {/* KeyboardAvoidingView lifts the form above the keyboard when it opens */}
        <KeyboardAvoidingView
          className="flex-1 bg-white"
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView>
            <View className="px-5 pt-8 pb-10">

              {/* Modal header */}
              <View className="flex-row items-center justify-between mb-8">
                <Text className="text-xl font-bold text-gray-900">Create Event</Text>
                <TouchableOpacity
                  onPress={closeModal}
                  disabled={createEventMutation.isPending}
                >
                  <Ionicons name="close" size={24} color="#6b7280" />
                </TouchableOpacity>
              </View>

              {/* Event type selector — three pill buttons: League / Tournament / Casual */}
              <View className="mb-6">
                <Text className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">
                  Type <Text className="text-red-500">*</Text>
                </Text>
                {/* flex-row with gap — each pill takes equal width via flex-1 */}
                <View className="flex-row gap-2">
                  {EVENT_TYPES.map((et) => {
                    const selected = newEventType === et.value;
                    return (
                      <TouchableOpacity
                        key={et.value}
                        // selected: solid green background; unselected: white with gray border
                        className={`flex-1 rounded-xl py-3 items-center border ${
                          selected
                            ? "bg-green-700 border-green-700"
                            : "bg-white border-gray-300"
                        }`}
                        onPress={() => setNewEventType(et.value)}
                        disabled={createEventMutation.isPending}
                      >
                        <Text
                          className={`text-sm font-semibold ${
                            selected ? "text-white" : "text-gray-600"
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
                <Text className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">
                  Name <Text className="text-red-500">*</Text>
                </Text>
                <TextInput
                  className="border border-gray-300 rounded-xl px-4 py-3 text-base bg-gray-50"
                  placeholder={
                    newEventType === "league"
                      ? "e.g. Saturday Morning League"
                      : newEventType === "tournament"
                      ? "e.g. Club Championship 2025"
                      : "e.g. Sunday Scramble"
                  }
                  value={newName}
                  onChangeText={setNewName}
                  autoCapitalize="words"
                  editable={!createEventMutation.isPending}
                  returnKeyType="next"
                />
              </View>

              {/* Description (optional) */}
              <View className="mb-8">
                <Text className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">
                  Description{" "}
                  <Text className="text-gray-400 normal-case font-normal">(optional)</Text>
                </Text>
                <TextInput
                  className="border border-gray-300 rounded-xl px-4 py-3 text-base bg-gray-50"
                  placeholder="A short description..."
                  value={newDescription}
                  onChangeText={setNewDescription}
                  multiline
                  numberOfLines={3}
                  // textAlignVertical: ensures text starts at the top of the input on Android
                  textAlignVertical="top"
                  editable={!createEventMutation.isPending}
                />
              </View>

              {/* Submit button */}
              <TouchableOpacity
                className={`rounded-xl py-4 items-center ${
                  createEventMutation.isPending ? "bg-green-400" : "bg-green-700"
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
