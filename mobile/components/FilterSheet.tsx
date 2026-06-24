// components/FilterSheet.tsx
// Generic bottom-sheet filter modal shared by the list screens (Events, Rounds).
//
// Renders one or more single-select sections (e.g. "Event Type", "Status") plus
// a "Clear All" row. Each section is driven by a FilterSheetSection: its current
// value, its options, and an onSelect callback. The screen owns the state and
// the meaning of each axis — this component only renders the rows and reports taps.
//
// Usage:
//   <FilterSheet
//     visible={filterVisible}
//     onClose={() => setFilterVisible(false)}
//     sections={[
//       { key: "type", title: "Event Type", options: TYPE_OPTIONS, selected: typeFilter, onSelect: setType },
//       { key: "status", title: "Status", options: STATUS_OPTIONS, selected: statusFilter, onSelect: setStatus },
//     ]}
//     showClearIcon={hasActiveFilters}
//     onClearAll={clearFilters}
//   />

import { View, Text, TouchableOpacity, Modal } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";

export interface FilterSheetOption {
  value: string;
  label: string;
}

export interface FilterSheetSection {
  key: string; // stable React key for the section
  title: string; // uppercase section heading
  options: FilterSheetOption[];
  selected: string;
  onSelect: (value: string) => void;
}

interface FilterSheetProps {
  visible: boolean;
  onClose: () => void;
  sections: FilterSheetSection[];
  // Resets every axis to its default (the screen decides what default means).
  onClearAll: () => void;
  // Shows the trash icon on the Clear All row only when something is filtered.
  showClearIcon: boolean;
}

export default function FilterSheet({
  visible,
  onClose,
  sections,
  onClearAll,
  showClearIcon,
}: FilterSheetProps) {
  const t = useTheme();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1">
        {/* Tap the backdrop to close */}
        <TouchableOpacity
          className="absolute inset-0 bg-black/40"
          activeOpacity={1}
          onPress={onClose}
        />

        <View className={`absolute bottom-0 left-0 right-0 ${t.surface} rounded-t-2xl pb-10`}>
          <View className={`flex-row items-center justify-between px-5 pt-5 pb-3 border-b ${t.divider}`}>
            <Text className={`text-base font-bold ${t.textPrimary}`}>Filter</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={22} color={t.colors.tabBarInactive} />
            </TouchableOpacity>
          </View>

          {/* Clear All — resets every axis to the screen's defaults */}
          <TouchableOpacity
            className={`flex-row items-center justify-between px-5 py-3 border-b ${t.divider}`}
            onPress={onClearAll}
          >
            <Text className="text-sm font-semibold text-red-500">Clear All</Text>
            {showClearIcon && <Ionicons name="trash-outline" size={16} color="#ef4444" />}
          </TouchableOpacity>

          {sections.map((section) => (
            <View key={section.key}>
              <View className="px-5 pt-4 pb-2">
                <Text className={`text-xs font-semibold uppercase tracking-widest ${t.textTertiary}`}>
                  {section.title}
                </Text>
              </View>

              {/* "checkmark-circle" = selected; "ellipse-outline" = unselected */}
              {section.options.map((opt) => {
                const selected = section.selected === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    className={`flex-row items-center justify-between px-5 py-3.5 border-b ${t.divider}`}
                    onPress={() => section.onSelect(opt.value)}
                  >
                    <Text
                      className={`text-sm ${selected ? "font-semibold" : ""} ${
                        selected ? t.textPrimary : t.textSecondary
                      }`}
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
          ))}
        </View>
      </View>
    </Modal>
  );
}
