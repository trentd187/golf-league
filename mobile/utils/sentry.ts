// utils/sentry.ts
// Single Sentry initialisation module for the Golf League app. Imported once from
// app/_layout.tsx via initSentry(); nothing else should call Sentry.init.
//
// Sentry is the app's only observability vendor — errors, distributed traces,
// structured logs (Sentry.logger.*), and session replay all flow here. It replaces
// the previous custom telemetry queue (utils/telemetry.ts) and OTel web tracer
// (utils/tracing.ts), both removed in the Sentry migration.
//
// Cross-platform: this module is safe on native and web. The replay integration is
// the only platform-specific piece — native uses the canvas recorder, web uses the
// DOM recorder — so it is chosen by Platform.OS. Everything else is shared.
//
// When EXPO_PUBLIC_SENTRY_DSN is unset (local dev / CI / Jest) the SDK initialises
// with an undefined DSN and silently sends nothing — the app runs identically.
//
// The config-building logic is split into small pure functions (resolveSentryEnvironment,
// buildSentryOptions) so it stays inside the Jest coverage set per the extract-first
// rule; initSentry itself is the only side-effecting entry point.

import * as Sentry from "@sentry/react-native";
import { Platform } from "react-native";
import Constants from "expo-constants";

// navigationIntegration is created once at module load so app/_layout.tsx can
// register it with the expo-router navigation container. It turns route changes
// into breadcrumbs and emits screen-load (TTID) spans.
export const navigationIntegration = Sentry.reactNavigationIntegration({
  // Time-to-initial-display instrumentation needs the native module, which is not
  // present in Expo Go. Constants.appOwnership === "expo" only inside Expo Go, so
  // enable TTID everywhere else (dev client / standalone builds).
  enableTimeToInitialDisplay: Constants.appOwnership !== "expo",
});

// resolveSentryEnvironment picks the environment tag attached to every event.
// Prefer the explicit EXPO_PUBLIC_SENTRY_ENVIRONMENT (set per EAS profile to
// development | preview | production); fall back to __DEV__ when it is unset.
export function resolveSentryEnvironment(
  explicit: string | undefined,
  isDev: boolean,
): string {
  if (explicit && explicit.length > 0) return explicit;
  return isDev ? "development" : "production";
}

// buildSentryOptions assembles the Sentry.init options object. Pure (it does not
// call Sentry.init) so it can be unit-tested against a mocked SDK.
export function buildSentryOptions(opts: {
  dsn: string | undefined;
  environment: string;
  isDev: boolean;
  platformOS: string;
}): Sentry.ReactNativeOptions {
  const { dsn, environment, isDev, platformOS } = opts;
  const isWeb = platformOS === "web";

  // Native replay sampling: full in dev for verification, 10% of sessions in prod.
  // Web is forced to 0 below so rrweb never records (see the integration note below).
  const nativeSessionReplayRate = isDev ? 1.0 : 0.1;

  return {
    dsn,
    environment,
    // First-party app — attach user email/IP. Sentry's recommended default.
    sendDefaultPii: true,
    // Route Sentry.logger.* records to Sentry Logs (searchable, no Issues quota).
    enableLogs: true,
    // Full trace sampling in dev for easy verification; 10% in prod to stay in quota.
    tracesSampleRate: isDev ? 1.0 : 0.1,
    // Relative to tracesSampleRate — profile every sampled transaction.
    profilesSampleRate: 1.0,
    // Replay sampling applies to native only; web records nothing (see below).
    replaysSessionSampleRate: isWeb ? 0 : nativeSessionReplayRate,
    replaysOnErrorSampleRate: isWeb ? 0 : 1.0,
    integrations: [
      navigationIntegration,
      // Session Replay is native-only. The web DOM recorder (rrweb + replay-canvas)
      // continuously snapshots the page; on screens with many user-avatar <img>
      // elements it drove the Chromium renderer into memory pressure and a
      // STATUS_ILLEGAL_INSTRUCTION crash — the same failure mode as the retired OTel
      // PerformanceObserver loop. Omit it on web entirely; the zero replay sample
      // rates above ensure rrweb never records. Native keeps the canvas recorder,
      // which is well-behaved.
      ...(isWeb ? [] : [Sentry.mobileReplayIntegration()]),
    ],
  };
}

// syncSentryUser attaches (or clears) the Sentry user context so every event is
// attributed to the signed-in user — powering release health, per-user error
// filtering, and replay identification. Pass null on sign-out. Accepts a minimal
// shape rather than Supabase's User type to avoid coupling this module to Supabase.
export function syncSentryUser(
  user: { id: string; email?: string } | null,
): void {
  if (user) {
    Sentry.setUser({ id: user.id, email: user.email });
  } else {
    Sentry.setUser(null);
  }
}

// reportQueryError routes a TanStack Query error to the right Sentry channel:
// 5xx and non-HTTP errors are captured as Issues; 4xx responses are expected
// client errors, so they become a warning log rather than an Issue. Extracted
// here (rather than inline in the QueryCache handler) so app/_layout.tsx — which
// is excluded from coverage — carries no logic.
export function reportQueryError(error: unknown): void {
  if (error instanceof Response) {
    if (error.status >= 500) {
      Sentry.captureException(
        new Error(`API ${error.status} error: ${error.url}`),
      );
    } else if (error.status >= 400) {
      Sentry.logger.warn("API client error", {
        status: error.status,
        url: error.url,
      });
    }
    return;
  }
  if (error instanceof Error) {
    Sentry.captureException(error);
  }
}

// initSentry initialises the SDK once at app start. Reads runtime config from
// EXPO_PUBLIC_* env vars (inlined into the bundle by Expo at build time).
export function initSentry(): void {
  Sentry.init(
    buildSentryOptions({
      dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
      environment: resolveSentryEnvironment(
        process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT,
        __DEV__,
      ),
      isDev: __DEV__,
      platformOS: Platform.OS,
    }),
  );
}
