// __tests__/app/users/[userId].test.tsx
// Tests for the public user profile screen.
//
// Covers:
//   - Loading state renders a spinner
//   - Error state renders an error message and back button
//   - Successful render shows the user's name, rounds/events counts
//   - Follow button is hidden when is_me is true (own profile)
//   - Follow button shows "Follow" when is_following is false
//   - Unfollow button shows when is_following is true
//   - Stats section shows a loading spinner while scorecards are fetching
//   - Empty stats state ("No completed rounds yet.") when no rounds returned
//   - Stats cards render when scorecard data is present

import React from "react";
import { render, fireEvent, act } from "@testing-library/react-native";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockUseQuery  = jest.fn();
const mockUseMutation = jest.fn();
const mockUseQueries  = jest.fn();
const mockUseQueryClient = jest.fn(() => ({
  setQueryData: jest.fn(),
  getQueryData: jest.fn(),
  invalidateQueries: jest.fn(),
}));

jest.mock("@tanstack/react-query", () => ({
  useQuery:       (...args: unknown[]) => mockUseQuery(...args),
  useMutation:    (...args: unknown[]) => mockUseMutation(...args),
  useQueries:     (...args: unknown[]) => mockUseQueries(...args),
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
    <View><Text>{displayName}</Text></View>
  );
});

// Mock the shared stat cards so tests don't need to supply full scorecard geometry.
jest.mock("@/components/StatCards", () => {
  const { View, Text } = require("react-native");
  return {
    ScoringCard:          () => <View><Text>ScoringCard</Text></View>,
    DirectionalMissCard:  () => <View><Text>DirectionalMissCard</Text></View>,
    PuttingCard:          () => <View><Text>PuttingCard</Text></View>,
  };
});

// Mock HandicapSection — tests here don't exercise handicap display.
jest.mock("@/components/HandicapSection", () => {
  const { View, Text } = require("react-native");
  return () => <View><Text>HandicapSection</Text></View>;
});

// Mock buildMyStats so tests control the returned stats shape without real scorecard data.
// buildGirByBand is also mocked — returns an empty All-band so the Approach compass
// renders without yardage chips (no approach_yds data in test scorecards).
const mockBuildMyStats = jest.fn();
jest.mock("@/utils/stats", () => ({
  buildMyStats:   (...args: unknown[]) => mockBuildMyStats(...args),
  buildGirByBand: () => [{ band: "All", girPercent: null, total: 0, miss: { left: 0, right: 0, short: 0, long: 0 } }],
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import UserProfileScreen from "@/app/users/[userId]";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockProfile = {
  id: "test-user-id-123",
  display_name: "Jane Golfer",
  avatar_url: null,
  rounds_played: 12,
  events_played: 3,
  is_following: false,
  is_me: false,
};

// Empty stats returned by buildMyStats when there are no scorecards.
const emptyStats = {
  rounds: 0,
  grossScores: [],
  avgGrossScore: null, lowScore: null, highScore: null,
  avgPar3: null, avgPar4: null, avgPar5: null,
  birdiesOrBetter: 0, parsCount: 0, bogeysCount: 0, doublesPlus: 0,
  firPercent: null, firMiss: { left: 0, right: 0, short: 0, long: 0 }, firTotal: 0,
  girPercent: null, girMiss: { left: 0, right: 0, short: 0, long: 0 }, girTotal: 0,
  girNaPercent: null, proximityRows: [],
  avgPuttsPerRound: null, puttDist: { one: 0, two: 0, three: 0, fourPlus: 0 },
  avgPuttMadeDistance: null, longestPuttMade: null,
};

// Stats with data — just needs rounds > 0 for the cards to render.
const filledStats = { ...emptyStats, rounds: 5, avgGrossScore: 82.5 };

// Stub returned for the hcStats query in tests that don't exercise handicap display.
const mockHcStats = { data: { handicap_index: null, anti_handicap: null }, isLoading: false, isError: false };

beforeEach(() => {
  jest.clearAllMocks();
  // Default: profile query loading, all others idle.
  mockUseQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false });
  mockUseMutation.mockReturnValue({ mutate: jest.fn(), isPending: false });
  mockUseQueries.mockReturnValue([]);
  mockBuildMyStats.mockReturnValue(emptyStats);
  // Reset the query client mock so each test gets a fresh stable object.
  mockUseQueryClient.mockImplementation(() => ({
    setQueryData: jest.fn(),
    getQueryData: jest.fn(),
    invalidateQueries: jest.fn(),
  }));
});

// ─── Tests ───────────────────────────────────────────────────────────────────

it("renders a loading spinner while the profile is fetching", () => {
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

it("pressing Go back in the error state calls router.back()", async () => {
  const backFn = jest.fn();
  jest.spyOn(require("expo-router"), "useRouter").mockReturnValue({ back: backFn, push: jest.fn() });
  mockUseQuery.mockReturnValue({ data: undefined, isLoading: false, isError: true });

  const { getByText } = render(<UserProfileScreen />);
  await act(async () => { fireEvent.press(getByText("Go back")); });
  expect(backFn).toHaveBeenCalled();
});

it("pressing the header back chevron calls router.back()", async () => {
  const backFn = jest.fn();
  jest.spyOn(require("expo-router"), "useRouter").mockReturnValue({ back: backFn, push: jest.fn() });
  mockUseQuery
    .mockReturnValueOnce({ data: mockProfile, isLoading: false, isError: false })
    .mockReturnValueOnce(mockHcStats)
    .mockReturnValueOnce({ data: [], isLoading: false, isError: false });

  const { UNSAFE_getAllByType } = render(<UserProfileScreen />);
  const { TouchableOpacity } = require("react-native");
  const touchables = UNSAFE_getAllByType(TouchableOpacity);
  await act(async () => { fireEvent.press(touchables[0]); });
  expect(backFn).toHaveBeenCalled();
});

it("renders the user's name and activity counts", () => {
  // Call order: profile → hcStats → roundRefs
  mockUseQuery
    .mockReturnValueOnce({ data: mockProfile, isLoading: false, isError: false })
    .mockReturnValueOnce(mockHcStats)
    .mockReturnValueOnce({ data: undefined, isLoading: true, isError: false });

  const { getAllByText } = render(<UserProfileScreen />);
  expect(getAllByText("Jane Golfer").length).toBeGreaterThanOrEqual(1);
});

it("shows Follow button for another user (is_me false, is_following false)", () => {
  mockUseQuery
    .mockReturnValueOnce({ data: mockProfile, isLoading: false, isError: false })
    .mockReturnValueOnce(mockHcStats)
    .mockReturnValueOnce({ data: [], isLoading: false, isError: false });

  const { getByText } = render(<UserProfileScreen />);
  expect(getByText("Follow")).toBeTruthy();
});

it("shows Unfollow button when already following", () => {
  const following = { ...mockProfile, is_following: true };
  mockUseQuery
    .mockReturnValueOnce({ data: following, isLoading: false, isError: false })
    .mockReturnValueOnce(mockHcStats)
    .mockReturnValueOnce({ data: [], isLoading: false, isError: false });

  const { getByText } = render(<UserProfileScreen />);
  expect(getByText("Unfollow")).toBeTruthy();
});

it("hides the follow button for own profile (is_me true)", () => {
  const ownProfile = { ...mockProfile, is_me: true };
  mockUseQuery
    .mockReturnValueOnce({ data: ownProfile, isLoading: false, isError: false })
    .mockReturnValueOnce(mockHcStats)
    .mockReturnValueOnce({ data: [], isLoading: false, isError: false });

  const { queryByText } = render(<UserProfileScreen />);
  expect(queryByText("Follow")).toBeNull();
  expect(queryByText("Unfollow")).toBeNull();
});

it("shows a stats loading spinner while scorecards are still fetching", () => {
  mockUseQuery
    .mockReturnValueOnce({ data: mockProfile, isLoading: false, isError: false })
    .mockReturnValueOnce(mockHcStats)
    .mockReturnValueOnce({ data: [{ id: "r1", scheduled_date: "2026-04-01" }], isLoading: false, isError: false });
  // One scorecard still loading.
  mockUseQueries.mockReturnValue([{ isLoading: true, data: undefined }]);

  const { UNSAFE_getAllByType } = render(<UserProfileScreen />);
  const { ActivityIndicator } = require("react-native");
  expect(UNSAFE_getAllByType(ActivityIndicator).length).toBeGreaterThanOrEqual(1);
});

it("shows no-rounds empty state when round refs list is empty", () => {
  mockUseQuery
    .mockReturnValueOnce({ data: mockProfile, isLoading: false, isError: false })
    .mockReturnValueOnce(mockHcStats)
    .mockReturnValueOnce({ data: [], isLoading: false, isError: false });
  mockBuildMyStats.mockReturnValue(emptyStats);

  const { getByText } = render(<UserProfileScreen />);
  expect(getByText("No completed rounds yet.")).toBeTruthy();
});

it("renders stat cards when scorecards are loaded", () => {
  mockUseQuery
    .mockReturnValueOnce({ data: mockProfile, isLoading: false, isError: false })
    .mockReturnValueOnce(mockHcStats)
    .mockReturnValueOnce({ data: [{ id: "r1", scheduled_date: "2026-04-01" }], isLoading: false, isError: false });
  mockUseQueries.mockReturnValue([{ isLoading: false, data: { round_id: "r1", groups: [], holes: [] } }]);
  mockBuildMyStats.mockReturnValue(filledStats);

  const { getByText, getAllByText } = render(<UserProfileScreen />);
  expect(getByText("ScoringCard")).toBeTruthy();
  // Two DirectionalMissCards: one for Driving, one for Approach.
  expect(getAllByText("DirectionalMissCard").length).toBe(2);
  expect(getByText("PuttingCard")).toBeTruthy();
});

it("calls the follow mutation when the Follow button is pressed", async () => {
  const mutateFn = jest.fn();
  mockUseMutation.mockReturnValue({ mutate: mutateFn, isPending: false });
  mockUseQuery
    .mockReturnValueOnce({ data: mockProfile, isLoading: false, isError: false })
    .mockReturnValueOnce(mockHcStats)
    .mockReturnValueOnce({ data: [], isLoading: false, isError: false });

  const { getByText } = render(<UserProfileScreen />);
  await act(async () => {
    fireEvent.press(getByText("Follow"));
  });
  expect(mutateFn).toHaveBeenCalledWith({ following: false });
});

it("follow onSuccess: flips profile cache and appends user to following list cache", async () => {
  // Use a stable client so we can assert on the exact same function instances.
  const stableClient = {
    setQueryData: jest.fn(),
    getQueryData: jest.fn().mockReturnValue(mockProfile),
    invalidateQueries: jest.fn(),
  };
  mockUseQueryClient.mockReturnValue(stableClient);

  let capturedOnSuccess: ((data: undefined, vars: { following: boolean }) => void) | undefined;
  mockUseMutation.mockImplementation((options: { onSuccess?: typeof capturedOnSuccess }) => {
    capturedOnSuccess = options.onSuccess;
    return { mutate: jest.fn(), isPending: false };
  });

  mockUseQuery
    .mockReturnValueOnce({ data: mockProfile, isLoading: false, isError: false })
    .mockReturnValueOnce(mockHcStats)
    .mockReturnValueOnce({ data: [], isLoading: false, isError: false });

  render(<UserProfileScreen />);

  await act(async () => {
    capturedOnSuccess!(undefined, { following: false }); // simulates a successful follow
  });

  // Verify profile cache updater flips is_following to true.
  const profileCall = stableClient.setQueryData.mock.calls.find(
    ([key]: [string[]]) => key[0] === "user"
  );
  expect(profileCall).toBeDefined();
  const profileUpdater = profileCall![1] as (prev: typeof mockProfile) => typeof mockProfile;
  expect(profileUpdater(mockProfile)).toEqual({ ...mockProfile, is_following: true });

  // Verify following list updater appends the followed user.
  const listCall = stableClient.setQueryData.mock.calls.find(
    ([key]: [string[]]) => key[0] === "users"
  );
  expect(listCall).toBeDefined();
  const listUpdater = listCall![1] as (prev: { id: string }[]) => { id: string }[];
  const existing = [{ id: "other", display_name: "Other", avatar_url: null, rounds_played: 3 }];
  const updated = listUpdater(existing);
  expect(updated).toContainEqual({
    id: "test-user-id-123",
    display_name: "Jane Golfer",
    avatar_url: null,
    rounds_played: 12,
  });

  expect(stableClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["users", "following"] });
});

it("unfollow onSuccess: flips profile cache and removes user from following list cache", async () => {
  const stableClient = {
    setQueryData: jest.fn(),
    getQueryData: jest.fn(),
    invalidateQueries: jest.fn(),
  };
  mockUseQueryClient.mockReturnValue(stableClient);

  let capturedOnSuccess: ((data: undefined, vars: { following: boolean }) => void) | undefined;
  mockUseMutation.mockImplementation((options: { onSuccess?: typeof capturedOnSuccess }) => {
    capturedOnSuccess = options.onSuccess;
    return { mutate: jest.fn(), isPending: false };
  });

  const followingProfile = { ...mockProfile, is_following: true };
  mockUseQuery
    .mockReturnValueOnce({ data: followingProfile, isLoading: false, isError: false })
    .mockReturnValueOnce(mockHcStats)
    .mockReturnValueOnce({ data: [], isLoading: false, isError: false });

  render(<UserProfileScreen />);

  await act(async () => {
    capturedOnSuccess!(undefined, { following: true }); // simulates a successful unfollow
  });

  // Verify profile cache updater flips is_following to false.
  const profileCall = stableClient.setQueryData.mock.calls.find(
    ([key]: [string[]]) => key[0] === "user"
  );
  const profileUpdater = profileCall![1] as (prev: typeof followingProfile) => typeof followingProfile;
  expect(profileUpdater(followingProfile)).toEqual({ ...followingProfile, is_following: false });

  // Verify following list updater removes this user.
  const listCall = stableClient.setQueryData.mock.calls.find(
    ([key]: [string[]]) => key[0] === "users"
  );
  const listUpdater = listCall![1] as (prev: { id: string }[]) => { id: string }[];
  const existing = [
    { id: "test-user-id-123", display_name: "Jane Golfer", avatar_url: null, rounds_played: 12 },
    { id: "other", display_name: "Other", avatar_url: null, rounds_played: 3 },
  ];
  const updated = listUpdater(existing);
  expect(updated).not.toContainEqual(expect.objectContaining({ id: "test-user-id-123" }));
  expect(updated).toContainEqual(expect.objectContaining({ id: "other" }));

  expect(stableClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["users", "following"] });
});
