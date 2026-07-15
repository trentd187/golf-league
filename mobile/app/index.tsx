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
import { reportAuthFailure } from "@/utils/sentry";

export default function Index() {
  const [session, setSession] = useState<Session | null>(null);
  // loading stays true until getSession() resolves — prevents a flash of the sign-in
  // screen before Supabase has restored a persisted session from localStorage.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data: { session }, error }) => {
        if (error) {
          // Stale or revoked refresh token in storage — clear it so the next launch is clean.
          // Expected after a long absence, so it's a Log, not an Issue.
          reportAuthFailure(error, { stage: "root_session_restore" });
          void supabase.auth.signOut();
        }
        setSession(error ? null : session);
        setLoading(false);
      })
      .catch((err: unknown) => {
        // getSession() REJECTING (rather than returning { error }) is exceptional — a broken
        // storage read, or, before utils/supabaseFetch.ts bounded it, a token refresh hung on
        // a dead socket. Without this catch, setLoading(false) never ran and the app's entry
        // route sat on a blank <View> FOREVER, with nothing in Sentry. Fail to sign-in
        // instead: the user can always sign in again, but they cannot escape a white screen.
        reportAuthFailure(err, { stage: "root_session_restore", fatal: true });
        setSession(null);
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
