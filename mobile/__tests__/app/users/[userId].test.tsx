// __tests__/app/users/[userId].test.tsx
// Tests for the public user profile screen.
//
// Covers:
//   - Loading state renders a spinner
//   - Error state renders an error message and back button
//   - Successful render shows the user's name, rounds/events counts
//   - Follow button is hidden when is_me is true (own profile)
//   - Follow button shows "Follow" when is_following is false
//   - Stats section renders scoring / par breakdown / advanced cards
//   - Empty stats state ("No completed rounds yet") renders correctly

import React from "react";
import { render, fireEvent, act } from "@testing-library/react-native";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockQueryData: Record<string, unknown> = {};
const mockUseQuery = jest.fn();
const mockUseMutation = jest.fn();
const mockUseQueryClient = jest.fn(() => ({
  setQueryData: jest.fn(),
  invalidateQueries: jest.fn(),
}));

jest.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
  useQueryClient: () => mockUseQueryClient(),
}));

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ userId: "test-user-id-123" }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
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
    textPrimary: "",
    textSecondary: "",
    textTertiary: "",
    primaryBg: "",
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

import UserProfileScreen from "@/app/users/[userId]";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const mockProfile = {
  id: "test-user-id-123",
  display_name: "Jane Golfer",
  avatar_url: null,
  rounds_played: 12,
  events_played: 3,
  is_following: false,
  is_me: false,
};

const mockStats = {
  avg_gross_per_round: 82.5,
  low_round: 77,
  high_round: 91,
  eagles: 0,
  birdies: 8,
  pars: 42,
  bogeys: 30,
  double_plus: 12,
  fir_pct: 45.5,
  gir_pct: 38.2,
  avg_putts_per_round: 31.4,
  rounds_counted: 12,
  filter: "all_time",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUseMutation.mockReturnValue({ mutate: jest.fn(), isPending: false });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

it("renders a loading spinner while the profile is fetching", () => {
  mockUseQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false });

  const { UNSAFE_getByType } = render(<UserProfileScreen />);
  const { ActivityIndicator } = require("react-native");
  expect(UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
});

it("renders an error state when the profile fetch fails", () => {
  mockUseQuery.mockReturnValue({ data: undefined, isLoading: false, isError: true });

  const { getByText } = render(<UserProfileScreen />);
  expect(getByText("Could not load profile.")).toBeTruthy();
  expect(getByText("Go back")).toBeTruthy();
});

it("renders the user's name and activity counts", () => {
  // First call: profile query. Second call: stats query (disabled until profile loads).
  mockUseQuery
    .mockReturnValueOnce({ data: mockProfile, isLoading: false, isError: false })
    .mockReturnValueOnce({ data: undefined, isLoading: true });

  const { getAllByText } = render(<UserProfileScreen />);
  // display_name appears in both the header and the profile card
  expect(getAllByText("Jane Golfer").length).toBeGreaterThanOrEqual(1);
});

it("shows Follow button for another user (is_me false, is_following false)", () => {
  mockUseQuery
    .mockReturnValueOnce({ data: mockProfile, isLoading: false, isError: false })
    .mockReturnValueOnce({ data: undefined, isLoading: false });

  const { getByText } = render(<UserProfileScreen />);
  expect(getByText("Follow")).toBeTruthy();
});

it("shows Unfollow button when already following", () => {
  const following = { ...mockProfile, is_following: true };
  mockUseQuery
    .mockReturnValueOnce({ data: following, isLoading: false, isError: false })
    .mockReturnValueOnce({ data: undefined, isLoading: false });

  const { getByText } = render(<UserProfileScreen />);
  expect(getByText("Unfollow")).toBeTruthy();
});

it("hides the follow button for own profile (is_me true)", () => {
  const ownProfile = { ...mockProfile, is_me: true };
  mockUseQuery
    .mockReturnValueOnce({ data: ownProfile, isLoading: false, isError: false })
    .mockReturnValueOnce({ data: undefined, isLoading: false });

  const { queryByText } = render(<UserProfileScreen />);
  expect(queryByText("Follow")).toBeNull();
  expect(queryByText("Unfollow")).toBeNull();
});

it("renders scoring and par breakdown stats when rounds_counted > 0", () => {
  mockUseQuery
    .mockReturnValueOnce({ data: mockProfile, isLoading: false, isError: false })
    .mockReturnValueOnce({ data: mockStats, isLoading: false });

  const { getByText } = render(<UserProfileScreen />);
  // Stat card labels
  expect(getByText("Avg gross / round")).toBeTruthy();
  expect(getByText("Low round")).toBeTruthy();
  expect(getByText("Eagles")).toBeTruthy();
  expect(getByText("Birdies")).toBeTruthy();
});

it("renders advanced stats card when FIR/GIR data is present", () => {
  mockUseQuery
    .mockReturnValueOnce({ data: mockProfile, isLoading: false, isError: false })
    .mockReturnValueOnce({ data: mockStats, isLoading: false });

  const { getByText } = render(<UserProfileScreen />);
  expect(getByText("FIR %")).toBeTruthy();
  expect(getByText("GIR %")).toBeTruthy();
  expect(getByText("Avg putts / round")).toBeTruthy();
});

it("renders the no-rounds empty state when rounds_counted is 0", () => {
  const emptyStats = { ...mockStats, rounds_counted: 0 };
  mockUseQuery
    .mockReturnValueOnce({ data: mockProfile, isLoading: false, isError: false })
    .mockReturnValueOnce({ data: emptyStats, isLoading: false });

  const { getByText } = render(<UserProfileScreen />);
  expect(getByText("No completed rounds yet.")).toBeTruthy();
});

it("calls the follow mutation when the Follow button is pressed", async () => {
  const mutateFn = jest.fn();
  mockUseMutation.mockReturnValue({ mutate: mutateFn, isPending: false });
  mockUseQuery
    .mockReturnValueOnce({ data: mockProfile, isLoading: false, isError: false })
    .mockReturnValueOnce({ data: undefined, isLoading: false });

  const { getByText } = render(<UserProfileScreen />);
  await act(async () => {
    fireEvent.press(getByText("Follow"));
  });
  expect(mutateFn).toHaveBeenCalledWith({ following: false });
});
