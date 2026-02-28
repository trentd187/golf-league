// app/(tabs)/_layout.tsx
// This is the layout for the tab navigator — the main navigation chrome of the app.
// In Expo Router, a _layout.tsx defines how all sibling screens in the same directory
// are presented. Here we use a Tabs layout, which shows a bottom tab bar.
//
// The "(tabs)" directory name uses Expo Router's "route group" syntax: the parentheses
// mean the group name is NOT included in the URL path. So "/(tabs)/index" renders at "/"
// (logically just the main area) rather than "/tabs".

// Tabs is Expo Router's built-in bottom tab navigator, built on React Navigation's tab bar.
import { Tabs } from "expo-router";

export default function TabLayout() {
  return (
    // Tabs renders the bottom tab bar and manages navigation between tab screens.
    // Each <Tabs.Screen> child corresponds to a screen file in the (tabs) directory.
    <Tabs
      screenOptions={{
        // tabBarActiveTintColor: the color of the active tab's icon and label.
        // #15803d is Tailwind's green-700 — matching the rest of the app's color scheme.
        tabBarActiveTintColor: "#15803d",

        // headerShown: false hides the top navigation header bar on all tab screens.
        // We disable it here because the tab screens provide their own headers or
        // don't need one at all.
        headerShown: false,
      }}
    >
      {/* Each Tabs.Screen maps to a file in the (tabs) directory.
          "name" must match the filename (without .tsx). "options.title" is the
          label shown under the tab icon in the bottom bar. */}
      <Tabs.Screen name="index" options={{ title: "Home" }} />
    </Tabs>
  );
}
