// app/index.tsx
// Root index screen — redirects to the correct part of the app based on auth state.
// Renders no visible UI: it immediately redirects and is never seen by the user.
//
// This pattern keeps route protection centralized: instead of checking auth in every
// screen, all users pass through here first on app load.

import { useEffect, useState } from "react";
import { View } from "react-native";
import { Redirect } from "expo-router";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/utils/supabase";

export default function Index() {
  const [session, setSession] = useState<Session | null>(null);
  // loading stays true until getSession() resolves — prevents a flash of the sign-in
  // screen before Supabase has restored a persisted session from localStorage.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session }, error }) => {
      if (error) {
        // Stale or revoked refresh token in storage — clear it so the next launch is clean.
        void supabase.auth.signOut();
      }
      setSession(error ? null : session);
      setLoading(false);
    });

    // Keep session state in sync if the auth state changes while the app is open.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  // Return a stable View (not null) during loading — returning null creates an empty
  // React fiber that, when immediately replaced by <Redirect>, causes
  // RetryableMountingLayerException in Android Fabric dev builds.
  if (loading) return <View className="flex-1" />;

  return session ? (
    <Redirect href="/(tabs)/events" />
  ) : (
    <Redirect href="/sign-in" />
  );
}
