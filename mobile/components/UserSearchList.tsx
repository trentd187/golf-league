// components/UserSearchList.tsx
// A search box + scrollable user list for picking a user to add somewhere.
//
// Used in:
//   - "Add Member to Event" modal  (events/[id].tsx)
//   - "Add Player to Group" modal   (rounds/[id].tsx, coming soon)
//
// Responsibilities of THIS component:
//   - Rendering the search input
//   - Filtering the passed user list by the current search query
//   - Rendering the matching user rows (avatar, name, email, add icon)
//   - Loading state (spinner) when the user list hasn't loaded yet
//   - Empty state with a contextual message
//
// Responsibilities of the PARENT:
//   - Fetching the full user list and passing it as `users` (undefined = still loading)
//   - Excluding already-added users before passing (e.g. filter out existing members)
//   - Owning the `search` string state (so it can reset to "" when the modal closes)
//   - Calling the actual add API in the `onSelect` handler

import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";

// ─── Types ────────────────────────────────────────────────────────────────────

// UserSummary matches the shape returned by GET /api/v1/users.
// Exported so screens that pass a user list to this component can type it correctly.
export type UserSummary = {
  id: string;
  display_name: string;
  email: string;
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface UserSearchListProps {
  // The user list to display and filter.
  // Pass `undefined` while the data is still loading — the component will show a spinner.
  // The parent should have already removed users who can't be added (e.g. existing members).
  users: UserSummary[] | undefined;

  // Controlled search query — the parent owns this state so it can reset it on modal close.
  search: string;
  onSearchChange: (text: string) => void;

  // Called when the user taps a row. Receives the selected user's ID.
  onSelect: (userId: string) => void;

  // True while the add mutation is in flight.
  // All rows are disabled and show a spinner instead of the add icon.
  isPending: boolean;

  // Placeholder text for the search input.
  // Default: "Search by name or email..."
  searchPlaceholder?: string;

  // Message shown when `users` is defined but empty AND there is no active search.
  // Use this to give context — e.g. "All users are already members of this event."
  // Default: "No users available."
  emptyMessage?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function UserSearchList({
  users,
  search,
  onSearchChange,
  onSelect,
  isPending,
  searchPlaceholder = "Search by name or email...",
  emptyMessage = "No users available.",
}: UserSearchListProps) {
  const t = useTheme();

  // Apply the text search on top of the already-filtered list the parent provided.
  // The parent handles exclusions (e.g. existing members); we handle text search.
  // (users ?? []) turns undefined into an empty array so .filter() doesn't crash.
  const filtered = (users ?? []).filter((u) => {
    // No search text → show all
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    // Match either display name or email (case-insensitive)
    return u.display_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

  return (
    // Fragment (<></>) lets us return multiple siblings without adding a wrapper View
    <>
      {/* ── Search box ────────────────────────────────────────────────────── */}
      {/* mx-5: 20px horizontal margin so the box aligns with the FlatList rows below.
          The FlatList uses contentContainerStyle paddingHorizontal: 20, matching this. */}
      <View
        className={`flex-row items-center border rounded-xl px-3 py-2 mx-5 mb-3 ${t.borderInput} ${t.surfaceSunken}`}
      >
        <Ionicons name="search-outline" size={16} color={t.colors.tabBarInactive} />
        <TextInput
          className={`flex-1 ml-2 text-base ${t.textPrimary}`}
          placeholder={searchPlaceholder}
          placeholderTextColor={t.colors.tabBarInactive}
          value={search}
          onChangeText={onSearchChange}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {/* ── User list (or loading / empty state) ──────────────────────────── */}

      {!users ? (
        // `users` is undefined: the parent's query hasn't resolved yet.
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={t.colors.tabBarActive} />
        </View>

      ) : filtered.length === 0 ? (
        // List is empty — either the search found nothing, or there are no users to add.
        <View className="flex-1 items-center justify-center px-8">
          <Text className={`text-sm text-center ${t.textTertiary}`}>
            {/* If there's an active search query, blame the search; otherwise use emptyMessage. */}
            {search.trim() ? "No users match your search." : emptyMessage}
          </Text>
        </View>

      ) : (
        // FlatList is the performant list renderer for potentially long lists.
        // For short lists (< ~20 items) it's essentially equivalent to .map() in a ScrollView,
        // but it virtualises longer lists to keep memory usage low.
        <FlatList
          data={filtered}
          // keyExtractor: React needs a unique key for each row to track re-renders efficiently.
          keyExtractor={(item) => item.id}
          // paddingHorizontal matches the mx-5 search box so everything lines up.
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
          renderItem={({ item }) => (
            <TouchableOpacity
              className={`flex-row items-center gap-3 py-3 border-b ${t.divider}`}
              onPress={() => onSelect(item.id)}
              // Disable all rows while a mutation is in flight to prevent double-tapping.
              disabled={isPending}
            >
              {/* Initials avatar — green-100/green-700 is categorical (not themed) */}
              <View className="w-10 h-10 rounded-full bg-green-100 items-center justify-center flex-shrink-0">
                <Text className="text-green-700 font-bold">
                  {item.display_name.charAt(0).toUpperCase()}
                </Text>
              </View>

              {/* Name + email — min-w-0 prevents text from overflowing the flex container */}
              <View className="flex-1 min-w-0">
                <Text className={`font-semibold text-sm ${t.textPrimary}`} numberOfLines={1}>
                  {item.display_name}
                </Text>
                <Text className={`text-xs ${t.textTertiary}`} numberOfLines={1}>
                  {item.email}
                </Text>
              </View>

              {/* Right side: spinner while mutation is pending, add icon otherwise.
                  Because the entire list is disabled, the spinner is shown on all rows,
                  not just the one being added. */}
              {isPending ? (
                <ActivityIndicator size="small" color={t.colors.tabBarActive} />
              ) : (
                <Ionicons name="add-circle-outline" size={22} color={t.colors.tabBarActive} />
              )}
            </TouchableOpacity>
          )}
        />
      )}
    </>
  );
}
