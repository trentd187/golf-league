// components/SectionHeader.tsx
// A consistent section heading row for detail screens (Event detail, Round detail, etc.).
// Shows a bold section title on the left and an optional "+ Action" button on the right.
//
// Usage:
//   <SectionHeader
//     title="Members (3)"
//     actionLabel="Add Member"
//     onAction={() => setAddMemberModalVisible(true)}
//     showAction={isOrganizer}   // pass false to hide the button for non-organizers
//   />

import { View, Text, TouchableOpacity } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";

interface SectionHeaderProps {
  title: string;
  actionLabel: string;
  onAction: () => void;
  showAction: boolean; // pass false to hide the action button entirely
}

export default function SectionHeader({
  title,
  actionLabel,
  onAction,
  showAction,
}: SectionHeaderProps) {
  const t = useTheme();

  return (
    <View className="flex-row items-center justify-between mb-3">
      <Text className={`text-base font-bold ${t.textPrimary}`}>{title}</Text>

      {showAction && (
        <TouchableOpacity
          className={`${t.primaryBg} rounded-xl px-3 py-1.5 flex-row items-center gap-1`}
          onPress={onAction}
        >
          <Ionicons name="add" size={15} color="white" />
          <Text className="text-white font-semibold text-xs">{actionLabel}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
