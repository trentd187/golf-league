// components/ErrorBoundary.tsx
// React error boundary that catches uncaught render errors in the component tree.
//
// Error boundaries MUST be class components — React does not support functional
// components for getDerivedStateFromError / componentDidCatch. This is a React
// core limitation, not an Expo or RN limitation.
//
// When a render error is caught the component:
//   1. Switches to a fallback red-card UI (hardcoded error colors per CLAUDE.md convention)
//   2. Ships the error to Loki via the telemetry client so it shows up in Grafana
//   3. Offers a "Try again" button that resets state and re-attempts the render

import React from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { getTelemetryClient } from "@/utils/telemetry";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: "" };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, errorMessage: error.message };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Ship the error to Loki so it appears in Grafana alongside the backend trace
    // for the most recent API call (trace_id is injected automatically by the client).
    const t = getTelemetryClient();
    t.error("react.error", error.message, {
      error_name: error.name,
      component_stack: info.componentStack ?? undefined,
    });
    // Flush immediately — render crashes often precede tab close on web, so waiting
    // for the 30-second batch timer means the error is silently lost.
    void t.flush();
  }

  render() {
    if (this.state.hasError) {
      return (
        <View className="flex-1 items-center justify-center bg-red-50 p-6">
          <Text className="mb-2 text-lg font-bold text-red-700">
            Something went wrong
          </Text>
          <Text className="mb-6 text-center text-sm text-red-600">
            {this.state.errorMessage}
          </Text>
          <TouchableOpacity
            className="rounded-lg bg-red-600 px-6 py-3"
            onPress={() => this.setState({ hasError: false, errorMessage: "" })}
          >
            <Text className="font-semibold text-white">Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return this.props.children;
  }
}
