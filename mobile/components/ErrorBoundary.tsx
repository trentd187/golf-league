// components/ErrorBoundary.tsx
// App-wide error boundary that catches uncaught render errors in the component tree.
//
// This is a thin wrapper around Sentry.ErrorBoundary: Sentry captures the error
// (with component stack, breadcrumbs, and user context) automatically, so we no
// longer need a hand-written class component or a manual telemetry call. We keep a
// custom fallback so users see a recovery card (hardcoded error colors per CLAUDE.md
// convention) instead of Sentry's default minimal fallback.

import React from "react";
import { Text, TouchableOpacity, View } from "react-native";
import * as Sentry from "@sentry/react-native";

interface Props {
  children: React.ReactNode;
}

// ErrorFallback is rendered by Sentry.ErrorBoundary when a descendant throws.
// resetError clears the boundary so the subtree re-attempts its render.
function ErrorFallback(props: { error: unknown; resetError: () => void }) {
  const message =
    props.error instanceof Error ? props.error.message : String(props.error);

  return (
    <View className="flex-1 items-center justify-center bg-red-50 p-6">
      <Text className="mb-2 text-lg font-bold text-red-700">
        Something went wrong
      </Text>
      <Text className="mb-6 text-center text-sm text-red-600">{message}</Text>
      <TouchableOpacity
        className="rounded-lg bg-red-600 px-6 py-3"
        onPress={props.resetError}
      >
        <Text className="font-semibold text-white">Try again</Text>
      </TouchableOpacity>
    </View>
  );
}

export function ErrorBoundary({ children }: Props) {
  // fallback receives { error, componentStack, eventId, resetError } from Sentry;
  // we only need error + resetError for the recovery card.
  return (
    <Sentry.ErrorBoundary
      fallback={({ error, resetError }) => (
        <ErrorFallback error={error} resetError={resetError} />
      )}
    >
      {children}
    </Sentry.ErrorBoundary>
  );
}
