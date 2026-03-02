// app/(tabs)/rounds.tsx
// The Rounds screen — where users will see active rounds and enter scores.
// Currently a placeholder. Real content (active and past rounds) will be added
// once the backend round endpoints and score entry flow are built.

import { Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";

// useTheme gives us the active theme's class strings and hex colors.
import { useTheme } from "@/hooks/useTheme";

export default function RoundsScreen() {
  // t: the active theme — drives background and text colors
  const t = useTheme();

  return (
    // t.screen: full-page background | items-center/justify-center: center all content
    <View className={`flex-1 items-center justify-center ${t.screen} px-6 gap-4`}>

      {/* Large flag icon — flags represent golf holes */}
      <Ionicons name="flag-outline" size={64} color={t.colors.tabBarActive} />

      {/* Screen title */}
      <Text className={`text-2xl font-bold ${t.textPrimary}`}>Rounds</Text>

      {/* Placeholder description */}
      <Text className={`text-base text-center ${t.textSecondary}`}>
        Active and completed rounds will appear here.
      </Text>

    </View>
  );
}
