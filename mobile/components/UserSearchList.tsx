// components/UserSearchList.tsx
// A search box + scrollable user list for picking a user to add.
//
// Used in:
//   - "Add Member to Event" modal  (events/[id].tsx)
//   - "Add Player to Group" modal  (rounds/[id].tsx)
//
// Responsibilities of THIS component:
//   - Rendering the search input and filtering by query
//   - Rendering matching user rows (avatar, name, email, add icon)
//   - Loading state (spinner) when `users` is undefined
//   - Empty state with a contextual message
//
// Responsibilities of the PARENT:
//   - Fetching the user list and passing it as `users` (undefined = still loading)
//   - Excluding already-added users before passing
//   - Owning the `search` state so it can reset to "" when the modal closes
//   - Calling the actual add API in `onSelect`

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
// Exported so parent screens can type their query data correctly.
export type UserSummary = {
  id: string;
  display_name: string;
  email: string;
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface UserSearchListProps {
  // Pass undefined while loading — the component shows a spinner.
  // The parent should have already removed users who can't be added.
  users: UserSummary[] | undefined;

  search: string;
  onSearchChange: (text: string) => void;

  // Called when the user taps a row, receives the selected user's ID.
  onSelect: (userId: string) => void;

  // True while the add mutation is in flight — disables all rows.
  isPending: boolean;

  searchPlaceholder?: string;
  // Message shown when `users` is defined but empty with no active search.
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

  // Apply text search on top of the already-filtered list the parent provided.
  // (users ?? []) turns undefined into [] so .filter() doesn't crash.
  const filtered = (users ?? []).filter((u) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return u.display_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

  return (
    <>
      {/* Search box — mx-5 aligns with the FlatList's paddingHorizontal: 20 */}
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

      {!users ? (
        // undefined = query not yet resolved
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={t.colors.tabBarActive} />
        </View>

      ) : filtered.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className={`text-sm text-center ${t.textTertiary}`}>
            {search.trim() ? "No users match your search." : emptyMessage}
          </Text>
        </View>

      ) : (
        // FlatList virtualises long lists to keep memory usage low.
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
          renderItem={({ item }) => (
            <TouchableOpacity
              className={`flex-row items-center gap-3 py-3 border-b ${t.divider}`}
              onPress={() => onSelect(item.id)}
              disabled={isPending} // prevent double-tap while mutation is in flight
            >
              {/* Initials avatar — green-100/green-700 is categorical, not themed */}
              <View className="w-10 h-10 rounded-full bg-green-100 items-center justify-center flex-shrink-0">
                <Text className="text-green-700 font-bold">
                  {item.display_name.charAt(0).toUpperCase()}
                </Text>
              </View>

              {/* min-w-0 prevents text from overflowing the flex container */}
              <View className="flex-1 min-w-0">
                <Text className={`font-semibold text-sm ${t.textPrimary}`} numberOfLines={1}>
                  {item.display_name}
                </Text>
                <Text className={`text-xs ${t.textTertiary}`} numberOfLines={1}>
                  {item.email}
                </Text>
              </View>

              {/* Spinner on all rows while pending (list is fully disabled anyway) */}
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
