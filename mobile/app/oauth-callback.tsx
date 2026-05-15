// app/oauth-callback.tsx
// Web-only OAuth callback route.
//
// After Google OAuth, the browser is redirected here with a PKCE code in the URL
// query params (e.g. /oauth-callback?code=xxx). Because detectSessionInUrl is true
// on web, the Supabase client automatically exchanges the code for a session as soon
// as it initialises on this page. We listen for the resulting SIGNED_IN event and
// redirect to the main app.
//
// This route is never reachable on native — the custom URL scheme (golfstuffinhere://)
// delivers the OAuth result directly to the app and is handled in sign-in.tsx.

import { useEffect } from "react";
import { View, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { supabase } from "@/utils/supabase";

export default function OAuthCallback() {
  const router = useRouter();

  useEffect(() => {
    // Check if Supabase already finished the code exchange (fast path).
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        router.replace("/(tabs)");
      }
    });

    // Listen for the SIGNED_IN event fired after Supabase completes the PKCE exchange.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session) {
        router.replace("/(tabs)");
      }
    });

    return () => subscription.unsubscribe();
  }, [router]);

  return (
    <View className="flex-1 items-center justify-center">
      <ActivityIndicator size="large" />
    </View>
  );
}
