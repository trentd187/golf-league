// app/(tabs)/rounds.tsx
// The Rounds screen — where users will see active rounds and enter scores.
// Currently a placeholder. Real content (active and past rounds) will be added
// once the backend round endpoints and score entry flow are built.

import { Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";

export default function RoundsScreen() {
  return (
    // flex-1: fill the screen | items-center/justify-center: center all content
    <View className="flex-1 items-center justify-center bg-gray-50 px-6 gap-4">

      {/* Large flag icon — flags represent golf holes */}
      <Ionicons name="flag-outline" size={64} color="#15803d" />

      {/* Screen title */}
      <Text className="text-2xl font-bold text-gray-800">Rounds</Text>

      {/* Placeholder description */}
      <Text className="text-gray-500 text-base text-center">
        Active and completed rounds will appear here.
      </Text>

    </View>
  );
}
