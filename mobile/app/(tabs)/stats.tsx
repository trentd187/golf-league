// app/(tabs)/stats.tsx
// Stats screen — scoring statistics and trends across rounds and events.
// Placeholder screen; advanced stat tracking to be implemented.

import { View, Text } from "react-native";
import { useTheme } from "@/hooks/useTheme";

export default function StatsScreen() {
  const t = useTheme();

  return (
    <View className={`flex-1 items-center justify-center ${t.screen}`}>
      <Text className={`text-base ${t.textSecondary}`}>Stats coming soon.</Text>
    </View>
  );
}
