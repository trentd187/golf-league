// app/+not-found.tsx
// Catch-all screen rendered by Expo Router when a URL doesn't match any route.
//
// In normal usage this would be a 404 page, but this app has one specific case where
// this screen appears legitimately: the Google/Apple OAuth callback.
//
// How OAuth deep links work:
//   1. The user taps "Continue with Google" on the sign-in screen.
//   2. expo-web-browser opens Google's sign-in page.
//   3. After the user authenticates, Google redirects to this app via a deep link, e.g.:
//        golfstuffinhere://oauth-native-callback
//   4. Expo Router receives that URL, finds no matching screen, and renders this file.
//      Without it, the user would see the default red "Unmatched Route" error for ~500ms.
//   5. Meanwhile, WebBrowser.maybeCompleteAuthSession() (called in sign-in.tsx) completes
//      the OAuth handshake, and sign-in.tsx's handleOAuth() calls router.replace("/(tabs)").
//
// The blank themed screen means the user sees a neutral flash instead of a red error page.

import { View } from "react-native";
import { useTheme } from "@/hooks/useTheme";

export default function NotFound() {
  const t = useTheme();
  // t.surface matches the sign-in screen background — the user sees this for < 1 second.
  return <View className={`flex-1 ${t.surface}`} />;
}
