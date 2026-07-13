// app/_layout.tsx
// Root Layout — wraps every screen in the app with shared providers and initialises
// observability.
//
// Sets up:
//   1. Sentry              — initialised before any component renders (utils/sentry.ts)
//   2. QueryClientProvider — server state management (caching API responses)
//   3. ErrorBoundary       — Sentry-backed boundary that catches uncaught render errors
//   4. Stack               — native screen navigation, registered with Sentry's
//                            navigation integration for route breadcrumbs / TTID spans
//
// No auth provider wrapper needed — the Supabase client is a singleton (utils/supabase.ts)
// and auth state is managed by the individual screens via useUser/useAuth hooks. Sentry's
// user context is attached in hooks/useUser.ts on auth state changes.

// Import global Tailwind/NativeWind styles — must be done exactly once at the app root.
import "../global.css";

// React Query manages server state: fetching, caching, synchronizing, and updating data.
// QueryCache/MutationCache let us add global error handlers that report failures to Sentry.
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from "@tanstack/react-query";
import NetInfo from "@react-native-community/netinfo";

import { useEffect } from "react";
import { AppState, AppStateStatus, Platform } from "react-native";
import * as Sentry from "@sentry/react-native";
import { Stack, useNavigationContainerRef } from "expo-router";
// KeyboardProvider powers react-native-keyboard-controller's KeyboardAwareScrollView
// (used on the scorecard) — it must wrap the app once at the root for the keyboard
// height tracking to work. Native module: requires a dev/preview build, not Expo Go.
import { KeyboardProvider } from "react-native-keyboard-controller";

import {
  initSentry,
  navigationIntegration,
  reportQueryError,
  reportMutationError,
} from "@/utils/sentry";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// Initialise Sentry at module load — before any component renders — so errors
// thrown during the first render are captured.
initSentry();

// QueryClient is created with global error handlers that report unexpected failures
// to Sentry: queries via QueryCache (Issues for 5xx, warning Logs for 4xx), and
// mutations via MutationCache (network rejections as Issues, app errors as warnings).
// The MutationCache handler runs alongside each mutation's own onError, so existing
// user-facing alerts are unaffected. Until this was added, mutation failures — the
// create/save operations that fail on cellular — left no Sentry telemetry at all.
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: reportQueryError,
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) =>
      reportMutationError(error, mutation.options.mutationKey),
  }),
  // Until now there were NO defaults at all, so every query ran on stock TanStack settings.
  // With polling as the only live-update mechanism, the retry policy is load-bearing, so it
  // gets stated explicitly.
  defaultOptions: {
    queries: {
      // Retry lives in ONE layer, and that layer is apiGet: it already does 3 attempts with
      // a per-attempt AbortController timeout and Full-Jitter backoff, and it reports the
      // failure with an endpoint label and a connection snapshot. Leaving TanStack's own
      // `retry: 3` on top would multiply that into nine attempts and a multi-minute tail
      // before a screen could even show an error — worse than useless on a flaky cell link.
      // It would also retry a 403 or a 404, which never heal.
      //
      // The one thing TanStack still owns is refetching when conditions CHANGE (below).
      retry: false,
      // A short staleTime collapses the duplicate fetches that fire when several screens
      // mount the same key at once (e.g. ["me"] on both Profile and Stats).
      staleTime: 10_000,
      // Now that onlineManager is wired to NetInfo (below), this actually fires: walking out
      // of a dead spot repaints the screen instead of leaving the player to pull-to-refresh.
      refetchOnReconnect: true,
    },
  },
});

// Configure React Query's focus detection for native only.
// React Query defaults to the browser's "visibilitychange" event (correct on web).
// On native, replace it with AppState so refetchOnWindowFocus works correctly.
// AppState is a no-op stub in react-native-web, so we guard explicitly.
if (Platform.OS !== "web") {
  focusManager.setEventListener((handleFocus) => {
    const subscription = AppState.addEventListener(
      "change",
      (state: AppStateStatus) => {
        handleFocus(state === "active");
      }
    );
    return () => subscription.remove();
  });

  // Teach React Query what "online" actually means on a phone.
  //
  // Its default online check leans on browser signals that don't exist in React Native, so
  // refetchOnReconnect never reliably fired — a player who walked out of a dead spot had to
  // pull-to-refresh by hand. NetInfo is the real answer, and this is where its subscription
  // now lives: it used to belong to the live-score WebSocket hook, which is gone. Re-homing
  // it here means the app still reacts to the network coming back, but it drives a refetch
  // instead of a socket reconnect storm.
  onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) => setOnline(!!state.isConnected)),
  );
}

function RootLayout() {
  // Register the expo-router navigation container with Sentry so route changes
  // become breadcrumbs and screen loads emit time-to-initial-display spans.
  const navigationRef = useNavigationContainerRef();
  useEffect(() => {
    if (navigationRef?.current) {
      navigationIntegration.registerNavigationContainer(navigationRef);
    }
  }, [navigationRef]);

  return (
    <KeyboardProvider>
      <QueryClientProvider client={queryClient}>
        {/* ErrorBoundary catches any uncaught render error, reports it to Sentry,
            and shows a recovery UI instead of a blank screen. */}
        <ErrorBoundary>
          <Stack screenOptions={{ headerShown: false }} />
        </ErrorBoundary>
      </QueryClientProvider>
    </KeyboardProvider>
  );
}

// Sentry.wrap enables automatic performance tracing of the root component tree
// and ties the navigation integration into the app lifecycle.
export default Sentry.wrap(RootLayout);
