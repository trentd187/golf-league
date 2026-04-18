// app/_layout.tsx
// This is the Root Layout — the top-level wrapper that wraps every screen in the app.
// In Expo Router, a _layout.tsx file in a directory defines the shared layout for all
// routes within that directory. The root _layout.tsx applies to the entire app.
//
// This file sets up:
//   1. ClerkProvider       — authentication state (is the user signed in? who are they?)
//   2. QueryClientProvider — server state management (caching API responses)
//   3. TelemetrySetup      — wires the Clerk token getter into the telemetry client
//   4. ErrorBoundary       — catches uncaught render errors and ships them to Loki
//   5. Stack               — native screen navigation

// Import global Tailwind/NativeWind styles — must be done exactly once at the app root.
import "../global.css";

// ClerkProvider is the authentication context wrapper. All Clerk hooks (useAuth, useUser, etc.)
// must be used inside ClerkProvider — it makes auth state available throughout the component tree.
// ClerkLoaded delays rendering children until Clerk has finished initializing, preventing
// a flash of unauthenticated UI while Clerk checks for a stored session.
import { ClerkProvider, ClerkLoaded, useAuth } from "@clerk/clerk-expo";

// React Query manages server state: fetching, caching, synchronizing, and updating data.
// QueryCache lets us add a global error handler for 5xx API errors.
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";

import { useEffect } from "react";
import { AppState, AppStateStatus } from "react-native";
import { Stack } from "expo-router";

import { tokenCache } from "@/utils/cache";
import { getTelemetryClient } from "@/utils/telemetry";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// QueryClient is created with a global QueryCache error handler that ships 5xx API
// errors and unexpected 4xx errors to Loki. trace_id and correlation_id are included
// automatically by the TelemetryClient so each error can be linked to a Tempo span.
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error: unknown) => {
      const t = getTelemetryClient();
      if (error instanceof Response) {
        if (error.status >= 500) {
          t.error("api.error", "API 5xx error", {
            status: error.status,
            url: error.url,
          });
        } else if (error.status >= 400) {
          t.warn("api.error", "API 4xx error", {
            status: error.status,
            url: error.url,
          });
        }
      } else if (error instanceof Error) {
        t.error("api.error", error.message);
      }
    },
  }),
});

// Configure React Query's focus detection for React Native.
// React Query defaults to the browser's "visibilitychange" event, which doesn't exist
// in React Native — replace it with AppState so refetchOnWindowFocus works correctly.
focusManager.setEventListener((handleFocus) => {
  const subscription = AppState.addEventListener(
    "change",
    (state: AppStateStatus) => {
      handleFocus(state === "active");
    }
  );
  return () => subscription.remove();
});

// TelemetrySetup must be rendered inside ClerkProvider so it can access useAuth.
// It wires the Clerk getToken function into the TelemetryClient (which needs it to
// attach a Bearer JWT to flush requests). The component renders nothing — it's
// purely a side-effect container.
function TelemetrySetup(): null {
  const { getToken } = useAuth();

  useEffect(() => {
    getTelemetryClient().setTokenGetter(() => getToken());
  }, [getToken]);

  // Flush queued telemetry entries when the app goes to the background so events
  // aren't lost if the process is killed. Log when the app returns to the foreground
  // so we can see session activity in Grafana.
  useEffect(() => {
    const subscription = AppState.addEventListener(
      "change",
      (state: AppStateStatus) => {
        const t = getTelemetryClient();
        if (state === "active") {
          t.info("app.foregrounded", "App returned to foreground");
        } else if (state === "background") {
          void t.flush();
        }
      }
    );
    return () => subscription.remove();
  }, []);

  return null;
}

// RootLayout is the default export — Expo Router automatically renders this as the root.
export default function RootLayout() {
  // The publishable key is safe to embed in the app — it's not a secret.
  const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!;

  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <ClerkLoaded>
        {/* TelemetrySetup must be inside ClerkLoaded so useAuth is available. */}
        <TelemetrySetup />
        <QueryClientProvider client={queryClient}>
          {/* ErrorBoundary catches any uncaught render error in the screen tree,
              ships it to Loki, and shows a recovery UI instead of a blank screen. */}
          <ErrorBoundary>
            <Stack screenOptions={{ headerShown: false }} />
          </ErrorBoundary>
        </QueryClientProvider>
      </ClerkLoaded>
    </ClerkProvider>
  );
}
