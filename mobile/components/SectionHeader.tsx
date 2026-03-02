// components/SectionHeader.tsx
// A consistent section heading row for detail screens (Event detail, Round detail, etc.).
// Shows a bold section title on the left and an optional "+ Action" button on the right.
//
// The action button uses the theme's primary color so it looks like an affordance
// (something you can tap), not just decorative text.
//
// Usage:
//   <SectionHeader
//     title="Members (3)"
//     actionLabel="Add Member"
//     onAction={() => setAddMemberModalVisible(true)}
//     showAction={isOrganizer}   // hide for non-organizers
//   />

import { View, Text, TouchableOpacity } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";

interface SectionHeaderProps {
  // The bold section title shown on the left (e.g. "Members (3)", "Rounds")
  title: string;
  // Label for the action button shown on the right (e.g. "Add Member", "Schedule")
  actionLabel: string;
  // Called when the user taps the action button
  onAction: () => void;
  // Set false to hide the action button entirely (e.g. for non-organizers)
  showAction: boolean;
}

export default function SectionHeader({
  title,
  actionLabel,
  onAction,
  showAction,
}: SectionHeaderProps) {
  // useTheme reads the active theme so this component responds to theme switches.
  const t = useTheme();

  return (
    <View className="flex-row items-center justify-between mb-3">
      <Text className={`text-base font-bold ${t.textPrimary}`}>{title}</Text>

      {/* Only render the action button when showAction is true.
          The {showAction && ...} pattern: if showAction is false, the && short-circuits
          and nothing is rendered. If true, the TouchableOpacity is rendered. */}
      {showAction && (
        <TouchableOpacity
          className={`${t.primaryBg} rounded-xl px-3 py-1.5 flex-row items-center gap-1`}
          onPress={onAction}
        >
          {/* The + icon sits left of the label text inside the button */}
          <Ionicons name="add" size={15} color="white" />
          <Text className="text-white font-semibold text-xs">{actionLabel}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
