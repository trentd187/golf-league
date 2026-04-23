// app/index.tsx
// Root index screen — redirects to the correct part of the app based on auth state.
// Renders no visible UI: it immediately redirects and is never seen by the user.
//
// This pattern keeps route protection centralized: instead of checking auth in every
// screen, all users pass through here first on app load.

import { useEffect, useState } from "react";
import { Redirect } from "expo-router";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/utils/supabase";

export default function Index() {
  const [session, setSession] = useState<Session | null>(null);
  // loading stays true until getSession() resolves — prevents a flash of the sign-in
  // screen before Supabase has restored a persisted session from localStorage.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
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

  if (loading) return null;

  return session ? (
    <Redirect href="/(tabs)" />
  ) : (
    <Redirect href="/sign-in" />
  );
}
