// app/_layout.tsx
// Root Layout — wraps every screen in the app with shared providers.
//
// Sets up:
//   1. QueryClientProvider — server state management (caching API responses)
//   2. TelemetrySetup      — wires the Supabase JWT getter into the telemetry client
//   3. ErrorBoundary       — catches uncaught render errors and ships them to Loki
//   4. Stack               — native screen navigation
//
// No auth provider wrapper needed — the Supabase client is a singleton (utils/supabase.ts)
// and auth state is managed by the individual screens via useUser/useAuth hooks.

// Import global Tailwind/NativeWind styles — must be done exactly once at the app root.
import "../global.css";

// React Query manages server state: fetching, caching, synchronizing, and updating data.
// QueryCache lets us add a global error handler for 5xx API errors.
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";

import { useEffect } from "react";
import { AppState, AppStateStatus, Platform } from "react-native";
import { Stack, usePathname } from "expo-router";

import { getTelemetryClient } from "@/utils/telemetry";
import { initWebTracing } from "@/utils/tracing";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useAuth } from "@/hooks/useAuth";

// QueryClient is created with a global QueryCache error handler that ships 5xx API
// errors and unexpected 4xx errors to Loki.
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

// TelemetrySetup wires the Supabase JWT getter into the TelemetryClient so telemetry
// flush requests are authenticated. Renders nothing — purely a side-effect component.
// Exported so tests can render it in isolation without the full RootLayout tree.
export function TelemetrySetup(): null {
  const { getToken } = useAuth();
  // Called unconditionally — Rules of Hooks require hooks at the top level.
  // The logging effect below guards on Platform.OS so native builds are unaffected.
  const pathname = usePathname();

  useEffect(() => {
    getTelemetryClient().setTokenGetter(() => getToken());
  }, [getToken]);

  // Log a session-start event on web page load so there is baseline signal in Loki
  // even when no errors occur. On native the AppState listener below covers this.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    getTelemetryClient().info("web.session.start", "Web session started");
  }, []);

  // Start the OTel browser tracer on web. Must run after the telemetry client is
  // wired up (above) so the session-start log fires first. initWebTracing() is
  // idempotent — safe to call on every render.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    initWebTracing();
  }, []);

  // Log a Loki event on every client-side route change (and on the initial page load).
  // This covers pages that never hit the backend — static SPA routes are otherwise
  // invisible in Grafana because Railway has no log drain for Caddy stdout.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    getTelemetryClient().info("web.navigation", pathname);
  }, [pathname]);

  // Flush queued telemetry when the app backgrounds; log when it foregrounds.
  // AppState is native-only — on web, the browser manages its own lifecycle.
  useEffect(() => {
    if (Platform.OS === "web") return;
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

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <TelemetrySetup />
      {/* ErrorBoundary catches any uncaught render error, ships it to Loki,
          and shows a recovery UI instead of a blank screen. */}
      <ErrorBoundary>
        <Stack screenOptions={{ headerShown: false }} />
      </ErrorBoundary>
    </QueryClientProvider>
  );
}
