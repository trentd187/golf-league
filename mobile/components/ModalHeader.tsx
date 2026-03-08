// components/ModalHeader.tsx
// Standard header row for all modal sheets in the app.
// Shows the modal title on the left and a close (✕) button on the right.
//
// Every modal uses this component so headers are visually consistent
// and don't need to be re-implemented inline.
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
  title: string;
  onClose: () => void;
  // Disables the close button while a mutation is in flight to prevent
  // accidental dismissal mid-save.
  disabled?: boolean;
}

export default function ModalHeader({ title, onClose, disabled }: ModalHeaderProps) {
  const t = useTheme();

  return (
    <View className="flex-row items-center justify-between mb-8">
      <Text className={`text-xl font-bold ${t.textPrimary}`}>{title}</Text>
      {/* hitSlop enlarges the tap target without affecting visual size */}
      <TouchableOpacity onPress={onClose} disabled={disabled} hitSlop={8}>
        <Ionicons name="close" size={24} color={t.colors.tabBarInactive} />
      </TouchableOpacity>
    </View>
  );
}
