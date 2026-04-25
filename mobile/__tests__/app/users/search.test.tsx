// __tests__/app/users/search.test.tsx
// Tests for the user search screen.
//
// Covers:
//   - Empty prompt shown when no query has been typed
//   - Loading spinner shown while first fetch is in progress
//   - No-results state shown when query returns an empty array
//   - Results list renders user rows when data is available
//   - Follow button text reflects the is_following flag on each row
//   - Tapping a row navigates to the user's profile
//   - Tapping the back button calls router.back()
//
// Note: the search input uses a 300 ms debounce. Tests that need results to
// appear use jest.useFakeTimers() + jest.advanceTimersByTime(400) inside act()
// to advance the debounce without waiting in real time.

import React from "react";
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockUseQuery = jest.fn();
const mockUseMutation = jest.fn();
const mockUseQueryClient = jest.fn(() => ({
  setQueriesData: jest.fn(),
  setQueryData: jest.fn(),
  invalidateQueries: jest.fn(),
}));

jest.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
  useQueryClient: () => mockUseQueryClient(),
}));

const mockBack = jest.fn();
const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ back: mockBack, push: mockPush }),
}));

jest.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ getToken: jest.fn().mockResolvedValue("test-token") }),
}));

jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    screen: "",
    surface: "",
    border: "",
    divider: "",
    borderInput: "",
    surfaceSunken: "",
    textPrimary: "",
    textSecondary: "",
    textTertiary: "",
    colors: { tabBarActive: "#15803d", tabBarInactive: "#9ca3af" },
  }),
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

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import UserSearchScreen from "@/app/users/search";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockUsers = [
  {
    id: "user-1",
    display_name: "Alice Fairway",
    email: "alice@example.com",
    avatar_url: null,
    is_following: false,
  },
  {
    id: "user-2",
    display_name: "Bob Bunker",
    email: "bob@example.com",
    avatar_url: null,
    is_following: true,
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockUseQuery.mockReturnValue({ data: undefined, isLoading: false, isFetching: false });
  mockUseMutation.mockReturnValue({ mutate: jest.fn(), isPending: false, variables: null });
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

// typeQuery fires a text change and advances the debounce timer so debouncedQuery
// updates and the conditional rendering branches are reached.
async function typeQuery(getByPlaceholderText: ReturnType<typeof render>["getByPlaceholderText"], text: string) {
  await act(async () => {
    fireEvent.changeText(getByPlaceholderText("Search by name or email…"), text);
  });
  act(() => {
    jest.advanceTimersByTime(400);
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

it("renders the header and search input", () => {
  const { getByText, getByPlaceholderText } = render(<UserSearchScreen />);
  expect(getByText("Find Players")).toBeTruthy();
  expect(getByPlaceholderText("Search by name or email…")).toBeTruthy();
});

it("shows the empty prompt when no query has been entered", () => {
  const { getByText } = render(<UserSearchScreen />);
  expect(getByText("Start typing to search for players by name or email.")).toBeTruthy();
});

it("shows a loading spinner when isLoading is true and no results cached", async () => {
  mockUseQuery.mockReturnValue({ data: undefined, isLoading: true, isFetching: true });

  const { getByPlaceholderText, UNSAFE_getByType } = render(<UserSearchScreen />);
  await typeQuery(getByPlaceholderText, "alice");

  const { ActivityIndicator } = require("react-native");
  expect(UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
});

it("shows the no-results state when the query returns an empty array", async () => {
  mockUseQuery.mockReturnValue({ data: [], isLoading: false, isFetching: false });

  const { getByPlaceholderText, getByText } = render(<UserSearchScreen />);
  await typeQuery(getByPlaceholderText, "zzz");

  expect(getByText(/No players found for/)).toBeTruthy();
});

it("renders a row for each result with name and email", async () => {
  mockUseQuery.mockReturnValue({ data: mockUsers, isLoading: false, isFetching: false });

  const { getByPlaceholderText, getAllByText, getByText } = render(<UserSearchScreen />);
  await typeQuery(getByPlaceholderText, "alice");

  // UserAvatar mock also renders displayName, so each name appears at least once.
  expect(getAllByText("Alice Fairway").length).toBeGreaterThanOrEqual(1);
  expect(getByText("alice@example.com")).toBeTruthy();
  expect(getAllByText("Bob Bunker").length).toBeGreaterThanOrEqual(1);
});

it("shows Follow for unfollowed users and Following for followed users", async () => {
  mockUseQuery.mockReturnValue({ data: mockUsers, isLoading: false, isFetching: false });

  const { getByPlaceholderText, getByText } = render(<UserSearchScreen />);
  await typeQuery(getByPlaceholderText, "bob");

  // user-1 is not following → "Follow"; user-2 is following → "Following"
  expect(getByText("Follow")).toBeTruthy();
  expect(getByText("Following")).toBeTruthy();
});

it("navigates to the user profile when a row is tapped", async () => {
  mockUseQuery.mockReturnValue({ data: mockUsers, isLoading: false, isFetching: false });

  const { getByPlaceholderText, getAllByText } = render(<UserSearchScreen />);
  await typeQuery(getByPlaceholderText, "alice");

  // Press the first occurrence of "Alice Fairway" (the row text, not the avatar text).
  await act(async () => {
    fireEvent.press(getAllByText("Alice Fairway")[0]);
  });

  expect(mockPush).toHaveBeenCalledWith("/users/user-1");
});

it("calls router.back when the back button is pressed", () => {
  const { UNSAFE_getAllByType } = render(<UserSearchScreen />);
  const { TouchableOpacity } = require("react-native");
  const buttons = UNSAFE_getAllByType(TouchableOpacity);

  fireEvent.press(buttons[0]);
  expect(mockBack).toHaveBeenCalled();
});

it("clears the query when the input is cleared", async () => {
  mockUseQuery.mockReturnValue({ data: mockUsers, isLoading: false, isFetching: false });

  const { getByPlaceholderText, getByText } = render(<UserSearchScreen />);
  await typeQuery(getByPlaceholderText, "alice");

  // Empty the input and advance debounce — empty prompt should return.
  await act(async () => {
    fireEvent.changeText(getByPlaceholderText("Search by name or email…"), "");
  });
  act(() => {
    jest.advanceTimersByTime(400);
  });

  expect(getByText("Start typing to search for players by name or email.")).toBeTruthy();
});
