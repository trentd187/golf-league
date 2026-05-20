// __tests__/components/ErrorBoundary.test.tsx
// Tests for the ErrorBoundary class component.
// Verifies that render crashes trigger telemetry.error + immediate telemetry.flush,
// and that the fallback UI is shown. Normal (no-error) render passes children through.

import React from "react";
import { Text } from "react-native";
import { render } from "@testing-library/react-native";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const mockError = jest.fn();
const mockFlush = jest.fn(() => Promise.resolve());

jest.mock("@/utils/telemetry", () => ({
  getTelemetryClient: () => ({
    error: mockError,
    flush: mockFlush,
  }),
}));

// Suppress React's console.error output for expected boundary catches so test output stays clean.
beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockError.mockClear();
  mockFlush.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Helper: throws during render when shouldThrow is true.
function Thrower({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("test render error");
  return null;
}

describe("ErrorBoundary", () => {
  it("renders children when there is no error", () => {
    const { getByText } = render(
      <ErrorBoundary>
        <Text>OK</Text>
      </ErrorBoundary>
    );
    expect(getByText("OK")).toBeTruthy();
  });

  it("calls telemetry.error with correct args on render crash", () => {
    render(
      <ErrorBoundary>
        <Thrower shouldThrow />
      </ErrorBoundary>
    );
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockError).toHaveBeenCalledWith(
      "react.error",
      "test render error",
      expect.objectContaining({ error_name: "Error" })
    );
  });

  it("immediately flushes telemetry on render crash", () => {
    render(
      <ErrorBoundary>
        <Thrower shouldThrow />
      </ErrorBoundary>
    );
    expect(mockFlush).toHaveBeenCalledTimes(1);
  });

  it("shows the fallback UI on render crash", () => {
    const { getByText } = render(
      <ErrorBoundary>
        <Thrower shouldThrow />
      </ErrorBoundary>
    );
    expect(getByText("Something went wrong")).toBeTruthy();
    expect(getByText("test render error")).toBeTruthy();
  });
});
