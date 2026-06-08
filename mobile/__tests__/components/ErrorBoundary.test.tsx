// __tests__/components/ErrorBoundary.test.tsx
// Tests for the ErrorBoundary wrapper around Sentry.ErrorBoundary.
// Sentry captures the error internally (verified by the SDK, not here); we test that
// children pass through normally, the recovery card shows on a render crash, and the
// "Try again" button resets the boundary. The @sentry/react-native manual mock provides
// a functional error boundary that renders our `fallback` render-prop on a thrown error.

import React from "react";
import { Text } from "react-native";
import { render, fireEvent } from "@testing-library/react-native";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// Suppress React's console.error noise for the expected boundary catch.
beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Throws during render when shouldThrow is true.
function Thrower({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("test render error");
  return null;
}

describe("ErrorBoundary", () => {
  it("renders children when there is no error", () => {
    const { getByText } = render(
      <ErrorBoundary>
        <Text>OK</Text>
      </ErrorBoundary>,
    );
    expect(getByText("OK")).toBeTruthy();
  });

  it("shows the recovery card with the error message on a render crash", () => {
    const { getByText } = render(
      <ErrorBoundary>
        <Thrower shouldThrow />
      </ErrorBoundary>,
    );
    expect(getByText("Something went wrong")).toBeTruthy();
    expect(getByText("test render error")).toBeTruthy();
    expect(getByText("Try again")).toBeTruthy();
  });

  it("resets the boundary when 'Try again' is pressed", () => {
    // A component that throws on first render, then succeeds after reset.
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error("test render error");
      return <Text>Recovered</Text>;
    }

    const { getByText } = render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );

    // Fallback is shown; flip the flag and press Try again to re-render the subtree.
    shouldThrow = false;
    fireEvent.press(getByText("Try again"));

    expect(getByText("Recovered")).toBeTruthy();
  });
});
