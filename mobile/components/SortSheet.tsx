// components/SortSheet.tsx
// Generic bottom-sheet sort modal shared by the list screens (Events, Rounds).
//
// Renders the sort options as a single-select list with a checkmark on the
// active one. Selecting an option reports it via onSelect; the caller updates
// state and closes the sheet (kept in the caller so it can persist the choice).
//
// Options may carry extra fields (e.g. a shortLabel for the trigger button) —
// only `value` and `label` are read here, so the screen can pass one shared
// option list to both this sheet and FilterSortBar.
//
// Usage:
//   <SortSheet
//     visible={sortVisible}
//     onClose={() => setSortVisible(false)}
//     options={SORT_OPTIONS}
//     selected={sortKey}
//     onSelect={(value) => { setSort(value); setSortVisible(false); }}
//   />

import { View, Text, TouchableOpacity, Modal } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";

export interface SortSheetOption {
  value: string;
  label: string;
}

interface SortSheetProps {
  visible: boolean;
  onClose: () => void;
  options: SortSheetOption[];
  selected: string;
  onSelect: (value: string) => void;
}

export default function SortSheet({
  visible,
  onClose,
  options,
  selected,
  onSelect,
}: SortSheetProps) {
  const t = useTheme();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1">
        <TouchableOpacity
          className="absolute inset-0 bg-black/40"
          activeOpacity={1}
          onPress={onClose}
        />

        <View className={`absolute bottom-0 left-0 right-0 ${t.surface} rounded-t-2xl pb-8`}>
          <View className={`flex-row items-center justify-between px-5 pt-5 pb-3 border-b ${t.divider}`}>
            <Text className={`text-base font-bold ${t.textPrimary}`}>Sort By</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={22} color={t.colors.tabBarInactive} />
            </TouchableOpacity>
          </View>

          {options.map((opt) => {
            const isSelected = selected === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                className={`flex-row items-center justify-between px-5 py-4 border-b ${t.divider}`}
                onPress={() => onSelect(opt.value)}
              >
                <Text
                  className={`text-base ${
                    isSelected ? `font-semibold ${t.textPrimary}` : t.textSecondary
                  }`}
                >
                  {opt.label}
                </Text>
                {isSelected && (
                  <Ionicons name="checkmark" size={18} color={t.colors.tabBarActive} />
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    </Modal>
  );
}
