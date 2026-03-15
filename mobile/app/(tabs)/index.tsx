// app/(tabs)/index.tsx
// Redirects the root tab route (/(tabs)) to Events, which is now the default landing tab.
// Expo Router always resolves index.tsx first when navigating to /(tabs) — this redirect
// ensures the user lands on Events instead of a blank or removed Home screen.

import { Redirect } from "expo-router";

export default function Index() {
  return <Redirect href="/(tabs)/events" />;
}
