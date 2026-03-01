// app/(tabs)/_layout.tsx
// Layout for the main tab navigator — defines the bottom tab bar and its four tabs.
// In Expo Router, _layout.tsx in a directory controls how all sibling screens are presented.
//
// The four tabs correspond to the four screen files in this directory:
//   index.tsx    → Home
//   events.tsx   → Events
//   rounds.tsx   → Rounds
//   profile.tsx  → Profile

// Tabs is Expo Router's built-in bottom tab navigator (built on React Navigation)
import { Tabs } from "expo-router";

// Ionicons is a large icon library bundled with Expo via @expo/vector-icons.
// No install needed — it comes with every Expo project.
import Ionicons from "@expo/vector-icons/Ionicons";

// ComponentProps lets us type the icon name prop using the real Ionicons type,
// so TypeScript will catch any invalid icon names at compile time.
import type { ComponentProps } from "react";

// This type represents any valid Ionicons icon name (e.g. "home", "trophy-outline")
type IoniconsName = ComponentProps<typeof Ionicons>["name"];

// TabBarIcon is a helper component that renders a single Ionicons icon for a tab.
// Each tab uses two icons: an outlined one when inactive, a filled one when active.
function TabBarIcon({ name, color }: { name: IoniconsName; color: string }) {
  // size={26}: standard tab bar icon size on both iOS and Android
  return <Ionicons name={name} size={26} color={color} />;
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        // Active tab icon and label color — green-700 matches the app brand colour
        tabBarActiveTintColor: "#15803d",

        // Inactive tab colour — a neutral gray so active tab stands out
        tabBarInactiveTintColor: "#9ca3af",

        // Hide the header bar on all tab screens (tabs have their own header or none at all)
        headerShown: false,

        // tabBarStyle: customize the bottom tab bar appearance
        tabBarStyle: {
          // A subtle top border to visually separate the tab bar from the screen content
          borderTopWidth: 1,
          borderTopColor: "#e5e7eb",   // Tailwind gray-200
          backgroundColor: "#ffffff",
        },
      }}
    >
      {/* Home tab — the landing screen after sign-in */}
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          // tabBarIcon receives "color" (active/inactive tint) and "focused" (boolean) from the navigator
          tabBarIcon: ({ color, focused }) => (
            // Show filled icon when active, outlined when inactive
            <TabBarIcon name={focused ? "home" : "home-outline"} color={color} />
          ),
        }}
      />

      {/* Events tab — browse and manage leagues and tournaments */}
      <Tabs.Screen
        name="events"
        options={{
          title: "Events",
          tabBarIcon: ({ color, focused }) => (
            <TabBarIcon name={focused ? "trophy" : "trophy-outline"} color={color} />
          ),
        }}
      />

      {/* Rounds tab — active rounds and score entry */}
      <Tabs.Screen
        name="rounds"
        options={{
          title: "Rounds",
          tabBarIcon: ({ color, focused }) => (
            // "flag" icons represent golf holes/flags — appropriate for the rounds screen
            <TabBarIcon name={focused ? "flag" : "flag-outline"} color={color} />
          ),
        }}
      />

      {/* Profile tab — user info, settings, and sign-out */}
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color, focused }) => (
            <TabBarIcon name={focused ? "person" : "person-outline"} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
