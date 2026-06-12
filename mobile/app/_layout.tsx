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
// QueryCache lets us add a global error handler that reports failures to Sentry.
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";

import { useEffect } from "react";
import { AppState, AppStateStatus, Platform } from "react-native";
import * as Sentry from "@sentry/react-native";
import { Stack, useNavigationContainerRef } from "expo-router";

import { initSentry, navigationIntegration, reportQueryError } from "@/utils/sentry";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// Initialise Sentry at module load — before any component renders — so errors
// thrown during the first render are captured.
initSentry();

// QueryClient is created with a global QueryCache error handler that reports 5xx /
// unexpected API errors to Sentry (Issues for 5xx, warning Logs for 4xx).
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: reportQueryError,
  }),
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
    <QueryClientProvider client={queryClient}>
      {/* ErrorBoundary catches any uncaught render error, reports it to Sentry,
          and shows a recovery UI instead of a blank screen. */}
      <ErrorBoundary>
        <Stack screenOptions={{ headerShown: false }} />
      </ErrorBoundary>
    </QueryClientProvider>
  );
}

// Sentry.wrap enables automatic performance tracing of the root component tree
// and ties the navigation integration into the app lifecycle.
export default Sentry.wrap(RootLayout);
