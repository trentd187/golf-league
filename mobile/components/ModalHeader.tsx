// components/ModalHeader.tsx
// Standard header row for all modal sheets in the app.
// Shows the modal title on the left and a close (✕) button on the right.
//
// Every modal (Edit Event, Add Member, Schedule Round, and future modals) uses
// this component so headers are visually consistent and don't need to be re-written.
//
// Usage:
//   <ModalHeader
//     title="Edit Event"
//     onClose={() => setEditModalVisible(false)}
//     disabled={updateEventMutation.isPending}   // prevents closing mid-save
//   />

import { View, Text, TouchableOpacity } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";

interface ModalHeaderProps {
  // The modal's title text (e.g. "Edit Event", "Add Member", "Schedule Round")
  title: string;
  // Called when the user taps the ✕ button
  onClose: () => void;
  // Optional: disables the close button while a mutation is in flight.
  // This prevents accidental dismissal mid-save, which could confuse the user.
  disabled?: boolean;
}

export default function ModalHeader({ title, onClose, disabled }: ModalHeaderProps) {
  const t = useTheme();

  return (
    // mb-8: leaves breathing room between the header and the first form field below it.
    // justify-between: pushes the title to the left edge and the ✕ to the right edge.
    <View className="flex-row items-center justify-between mb-8">
      <Text className={`text-xl font-bold ${t.textPrimary}`}>{title}</Text>

      {/* hitSlop enlarges the tap target without changing the button's visual size.
          A number is shorthand for { top: 8, left: 8, bottom: 8, right: 8 }. */}
      <TouchableOpacity onPress={onClose} disabled={disabled} hitSlop={8}>
        <Ionicons name="close" size={24} color={t.colors.tabBarInactive} />
      </TouchableOpacity>
    </View>
  );
}
