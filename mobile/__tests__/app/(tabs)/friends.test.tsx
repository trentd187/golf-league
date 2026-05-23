// __tests__/app/(tabs)/friends.test.tsx
// Tests for the FriendsScreen — following list and Find Players navigation.
//
// Covers:
//   - Loading spinner while the following query is in flight
//   - Empty-state message when the list is empty
//   - A row per followed player with name and round count
//   - Tapping a following row navigates to that user's profile
//   - Find Players row navigates to /users/search

import React from "react";
import { render, fireEvent, waitFor, act } from "@testing-library/react-native";

// --- Mocks ---

const mockUseQuery = jest.fn();

jest.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

jest.mock("@/hooks/useUser", () => ({
  useUser: () => ({
    user: { id: "test-user-id", email: "test@example.com" },
    loading: false,
  }),
}));

jest.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ getToken: jest.fn().mockResolvedValue("test-token") }),
}));

jest.mock("@/utils/api", () => ({
  apiFetch: jest.fn(),
}));

jest.mock("@/constants/api", () => ({
  API_URL: "http://localhost:8080",
}));

jest.mock("@/components/UserAvatar", () => {
  const { View, Text } = require("react-native");
  return ({ displayName }: { displayName: string }) => (
    <View>
      <Text>{displayName}</Text>
    </View>
  );
});

// useRouter is jest.fn() so individual tests can override push/replace.
jest.mock("expo-router", () => ({
  useRouter: jest.fn(() => ({ replace: jest.fn(), push: jest.fn() })),
}));

jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    screen: "",
    surface: "",
    border: "",
    divider: "",
    textPrimary: "",
    textSecondary: "",
    textTertiary: "",
    colors: { tabBarActive: "#15803d", tabBarInactive: "#ccc" },
  }),
}));

// --- Import (after mocks) ---

import FriendsScreen from "@/app/(tabs)/friends";

beforeEach(() => {
  jest.clearAllMocks();
  mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
});

// ─── Following list ───────────────────────────────────────────────────────────

it("shows a loading spinner while the following list is fetching", () => {
  mockUseQuery.mockReturnValue({ data: undefined, isLoading: true });

  const { UNSAFE_getByType } = render(<FriendsScreen />);
  const { ActivityIndicator } = require("react-native");
  expect(UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
});

it("shows an empty-state message when following nobody", () => {
  mockUseQuery.mockReturnValue({ data: [], isLoading: false });

  const { getByText } = render(<FriendsScreen />);
  expect(getByText("You're not following anyone yet.")).toBeTruthy();
});

it("renders a row for each followed player", () => {
  mockUseQuery.mockReturnValue({
    data: [
      { id: "u1", display_name: "Alice Fairway", avatar_url: null, rounds_played: 5 },
      { id: "u2", display_name: "Bob Bunker", avatar_url: null, rounds_played: 1 },
    ],
    isLoading: false,
  });

  const { getAllByText, getByText } = render(<FriendsScreen />);
  expect(getAllByText("Alice Fairway").length).toBeGreaterThanOrEqual(1);
  expect(getAllByText("Bob Bunker").length).toBeGreaterThanOrEqual(1);
  // Singular "round" for 1 round, plural "rounds" for 5.
  expect(getByText("5 rounds played")).toBeTruthy();
  expect(getByText("1 round played")).toBeTruthy();
});

it("navigates to the player profile when a following row is tapped", async () => {
  const mockPush = jest.fn();
  require("expo-router").useRouter.mockReturnValue({ replace: jest.fn(), push: mockPush });

  mockUseQuery.mockReturnValue({
    data: [{ id: "u1", display_name: "Alice Fairway", avatar_url: null, rounds_played: 3 }],
    isLoading: false,
  });

  const { getAllByText } = render(<FriendsScreen />);
  await act(async () => {
    fireEvent.press(getAllByText("Alice Fairway")[0]);
  });
  expect(mockPush).toHaveBeenCalledWith("/users/u1");
});

// ─── Find Players ─────────────────────────────────────────────────────────────

it("navigates to /users/search when Find Players is tapped", async () => {
  const mockPush = jest.fn();
  require("expo-router").useRouter.mockReturnValue({ replace: jest.fn(), push: mockPush });

  const { getByText } = render(<FriendsScreen />);
  await act(async () => {
    fireEvent.press(getByText("Find Players"));
  });
  expect(mockPush).toHaveBeenCalledWith("/users/search");
});
