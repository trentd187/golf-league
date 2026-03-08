// app/+not-found.tsx
// Catch-all screen rendered by Expo Router when a URL doesn't match any route in the app/ directory.
//
// In normal usage this would be a 404 page, but this app currently has one specific case
// where this screen appears legitimately: the Google/Facebook/Apple OAuth callback.
//
// How OAuth deep links work:
//   1. The user taps "Continue with Google" on the sign-in screen.
//   2. expo-web-browser opens Google's sign-in page.
//   3. After the user authenticates, Google redirects to this app via a deep link, e.g.:
//        golfstufinhere://oauth-native-callback
//   4. Expo Router receives that URL and tries to find a matching screen.
//      There is no app/oauth-native-callback.tsx, so without this file it would show
//      the default red "Unmatched Route" development error page for ~500ms.
//   5. Meanwhile, WebBrowser.maybeCompleteAuthSession() (called in sign-in.tsx) completes
//      the OAuth handshake, and sign-in.tsx's handleOAuth() calls router.replace("/(tabs)").
//
// This file renders a blank screen that matches the sign-in background, so the user sees
// a neutral flash instead of a jarring red error page during that brief OAuth transition.

import { View } from "react-native";

// useTheme gives us the active theme's class strings so the background matches the sign-in screen.
import { useTheme } from "@/hooks/useTheme";

export default function NotFound() {
  // t.surface matches the background used on the sign-in screen, making the brief
  // OAuth redirect window look like a natural loading pause rather than an error.
  const t = useTheme();

  // Render a full-screen blank view — no text, no spinner, just a background.
  // The user sees this for less than a second before the OAuth flow completes.
  return <View className={`flex-1 ${t.surface}`} />;
}
