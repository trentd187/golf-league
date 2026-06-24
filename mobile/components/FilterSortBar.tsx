// components/FilterSortBar.tsx
// The Filter + Sort button row shown above a list screen (Events, Rounds).
//
// Shared so both list screens render an identical control bar — opening the
// FilterSheet / SortSheet is the caller's job (this is purely the trigger row).
//
// The Filter button highlights green when any filter is active (a categorical
// "on" signal, like the badges — see CLAUDE.md); the inactive state uses theme
// tokens so it reads correctly in dark / high-contrast mode. The Sort button
// shows the current sort's short label.
//
// Usage:
//   <FilterSortBar
//     hasActiveFilters={hasActiveFilters}
//     sortLabel={currentSortShortLabel}
//     onOpenFilter={() => setFilterVisible(true)}
//     onOpenSort={() => setSortVisible(true)}
//   />

import { View, Text, TouchableOpacity } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";

interface FilterSortBarProps {
  hasActiveFilters: boolean;
  sortLabel: string;
  onOpenFilter: () => void;
  onOpenSort: () => void;
}

export default function FilterSortBar({
  hasActiveFilters,
  sortLabel,
  onOpenFilter,
  onOpenSort,
}: FilterSortBarProps) {
  const t = useTheme();

  return (
    <View className="px-5 flex-row items-center gap-2 mb-4">
      {/* Filter button — green when any filter is active, themed surface otherwise */}
      <TouchableOpacity
        className={`flex-row items-center gap-1.5 border rounded-xl px-3 py-2 ${
          hasActiveFilters ? "bg-green-50 border-green-300" : `${t.surface} ${t.border}`
        }`}
        onPress={onOpenFilter}
      >
        <Ionicons
          name="options-outline"
          size={14}
          color={hasActiveFilters ? "#15803d" : t.colors.tabBarInactive}
        />
        <Text
          className={`text-xs font-semibold ${
            hasActiveFilters ? "text-green-700" : t.textSecondary
          }`}
        >
          {/* Bullet after "Filter" when active so the user sees something is on */}
          Filter{hasActiveFilters ? "  •" : ""}
        </Text>
      </TouchableOpacity>

      {/* Sort button — shows the current sort's short label */}
      <TouchableOpacity
        className={`flex-row items-center gap-1.5 border rounded-xl px-3 py-2 ${t.surface} ${t.border}`}
        onPress={onOpenSort}
      >
        <Ionicons name="swap-vertical-outline" size={14} color={t.colors.tabBarInactive} />
        <Text className={`text-xs font-semibold ${t.textSecondary}`}>{sortLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}
