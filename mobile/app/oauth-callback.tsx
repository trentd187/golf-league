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
//
// The exchange is not guaranteed to finish. An expired code, a network drop, or a rejected
// getSession() all end with SIGNED_IN never firing — and this screen used to be an
// ActivityIndicator with no error path and no timeout, so the user just watched it spin,
// forever, with nothing in Sentry. Every terminal state is now handled: success redirects,
// failure shows a way back to sign-in.

import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, ActivityIndicator, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { supabase } from "@/utils/supabase";
import { reportAuthFailure } from "@/utils/sentry";

// How long to wait for Supabase to complete the PKCE exchange before calling it a failure.
// Generous: the exchange is a single round-trip, but it happens on whatever network just
// came back from the OAuth browser hop.
const EXCHANGE_TIMEOUT_MS = 20000;

export default function OAuthCallback() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  // Guards the timeout from firing after we've already redirected — an effect cleanup can't
  // cancel a redirect that already happened.
  const settledRef = useRef(false);

  const succeed = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    router.replace("/(tabs)/events");
  }, [router]);

  const fail = useCallback((err: unknown, stage: string) => {
    if (settledRef.current) return;
    settledRef.current = true;
    reportAuthFailure(err, { stage, fatal: true });
    setFailed(true);
  }, []);

  useEffect(() => {
    // Check whether Supabase already finished the code exchange (fast path).
    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        if (session) succeed();
      })
      .catch((err: unknown) => fail(err, "oauth_callback_get_session"));

    // Listen for the SIGNED_IN event fired after Supabase completes the PKCE exchange.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session) succeed();
    });

    // The backstop: if neither path resolves, stop spinning and say so.
    const timer = setTimeout(
      () => fail(new Error("OAuth code exchange timed out"), "oauth_callback_timeout"),
      EXCHANGE_TIMEOUT_MS,
    );

    return () => {
      subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, [succeed, fail]);

  if (failed) {
    return (
      <View className="flex-1 items-center justify-center bg-white p-6 dark:bg-gray-900">
        <Text className="mb-2 text-center text-lg font-semibold text-gray-900 dark:text-gray-100">
          Sign-in didn&apos;t complete
        </Text>
        <Text className="mb-6 text-center text-gray-600 dark:text-gray-400">
          The link may have expired, or the connection dropped. Please try signing in again.
        </Text>
        <TouchableOpacity
          onPress={() => router.replace("/sign-in")}
          activeOpacity={0.7}
          className="rounded-lg bg-green-700 px-6 py-3"
        >
          <Text className="font-semibold text-white">Back to sign in</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View className="flex-1 items-center justify-center">
      <ActivityIndicator size="large" />
    </View>
  );
}
