// __tests__/app/(tabs)/index.test.tsx
// Tests for the /(tabs) safety-net redirect.
// Verifies that the component redirects to /(tabs)/events via router.replace on mount.

import React from "react";
import { render, waitFor, act } from "@testing-library/react-native";

// --- Mocks ---

const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

// --- Imports (after mocks) ---

import TabsIndex from "@/app/(tabs)/index";

beforeEach(() => {
  jest.clearAllMocks();
});

it("redirects to /(tabs)/events on mount", async () => {
  render(<TabsIndex />);

  await waitFor(() => {
    expect(mockReplace).toHaveBeenCalledWith("/(tabs)/events");
  });
});

it("renders a stable view while the effect is pending", () => {
  const { toJSON } = render(<TabsIndex />);
  expect(toJSON()).not.toBeNull();
});

it("calls replace exactly once per mount", async () => {
  render(<TabsIndex />);

  await waitFor(() => expect(mockReplace).toHaveBeenCalled());
  expect(mockReplace).toHaveBeenCalledTimes(1);
});

it("unsubscribes router effect on unmount without errors", () => {
  const { unmount } = render(<TabsIndex />);
  expect(() => {
    act(() => {
      unmount();
    });
  }).not.toThrow();
});
