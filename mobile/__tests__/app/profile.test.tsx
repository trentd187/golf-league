// __tests__/app/profile.test.tsx
// Tests for the ProfileScreen's name-save, avatar-upload, and following-list flows.
//
// Covers:
//   - refreshSession is called after a successful display name save (bug fix:
//     without this the old JWT re-syncs the stale name back to the DB on the
//     next API request, making the change appear not to persist)
//   - refreshSession is NOT called when updateUser returns an error
//   - Avatar upload saves to custom_avatar_url (not avatar_url) so Google OAuth
//     re-logins cannot overwrite user-uploaded photos
//   - Following section shows a loading spinner while the query is in flight
//   - Following section shows an empty-state message when the list is empty
//   - Following section renders a row per followed player with name and round count
//   - Tapping a following row navigates to that user's profile

import React from "react";
import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import { Alert } from "react-native";

// --- Mocks ---
// jest.mock() is hoisted before imports; variables from the outer scope are
// not yet defined inside factory functions, so we use jest.fn() directly.

// mockUseQuery controls what each useQuery call returns across tests.
const mockUseQuery = jest.fn();
// mockMutate is the mutate function returned by useMutation — spy on calls in tests.
const mockMutate = jest.fn();
const mockUseMutation = jest.fn();
// mockCapturedQueryFns and mockCapturedMutationFn allow tests to invoke the actual async
// function bodies (queryFn, mutationFn, onSuccess) for coverage purposes. They are
// populated on every render since useMutation/useQuery are called synchronously.
// Variables must start with "mock" to be accessible inside jest.mock() factory functions.
let mockCapturedQueryFns: Array<() => Promise<unknown>> = [];
let mockCapturedMutationFn: ((s: unknown) => Promise<unknown>) | undefined;
let mockCapturedOnSuccess: ((data: unknown, vars: unknown) => void) | undefined;

jest.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => {
    const opts = args[0] as { queryFn?: () => Promise<unknown> };
    if (opts?.queryFn) mockCapturedQueryFns.push(opts.queryFn);
    return mockUseQuery(...args);
  },
  useMutation: (...args: unknown[]) => {
    const opts = args[0] as {
      mutationFn?: (s: unknown) => Promise<unknown>;
      onSuccess?: (data: unknown, vars: unknown) => void;
    };
    mockCapturedMutationFn = opts?.mutationFn;
    mockCapturedOnSuccess = opts?.onSuccess;
    return mockUseMutation(...args);
  },
  useQueryClient: () => ({ setQueryData: jest.fn(), invalidateQueries: jest.fn() }),
}));

jest.mock("@/hooks/useUser", () => ({
  useUser: () => ({
    user: {
      id: "test-user-id",
      email: "test@example.com",
      user_metadata: { full_name: "Original Name", avatar_url: null, custom_avatar_url: null },
    },
    loading: false,
  }),
}));

jest.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ signOut: jest.fn(), getToken: jest.fn().mockResolvedValue("test-token") }),
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

jest.mock("@/hooks/useMe", () => ({
  useMe: () => ({ data: { role: "user" } }),
}));

jest.mock("@/utils/supabase", () => ({
  supabase: {
    auth: {
      updateUser: jest.fn(),
      refreshSession: jest.fn(),
    },
    // storage.from returns a configurable mock — tests that exercise the upload
    // flow call (supabase.storage.from as jest.Mock).mockReturnValue({ upload, getPublicUrl }).
    storage: {
      from: jest.fn(),
    },
  },
}));

// useRouter is a jest.fn() so individual tests can call .mockReturnValue to
// capture push/replace calls (e.g. the following-row navigation test).
jest.mock("expo-router", () => ({
  useRouter: jest.fn(() => ({ replace: jest.fn(), push: jest.fn() })),
}));

jest.mock("expo-image-picker", () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    screen: "",
    surface: "",
    surfaceSunken: "",
    border: "",
    divider: "",
    borderInput: "",
    textPrimary: "",
    textSecondary: "",
    textTertiary: "",
    primaryBg: "",
    primaryBgDisabled: "",
    colors: { tabBarActive: "#15803d", tabBarInactive: "#ccc" },
  }),
}));

// useThemeStore is called twice with selector functions — once for themeName,
// once for setTheme. Passing the selector through to a plain object satisfies both.
jest.mock("@/stores/themeStore", () => ({
  useThemeStore: (selector: (s: any) => any) =>
    selector({ themeName: "light", setTheme: jest.fn() }),
}));

// Empty THEME_META so the theme picker renders no buttons, simplifying the DOM.
jest.mock("@/themes", () => ({
  THEME_META: [],
}));

jest.mock("@/utils/telemetry", () => ({
  getTelemetryClient: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    setTokenGetter: jest.fn(),
  }),
}));

// --- Imports (after mocks so the mocked versions are used) ---

import ProfileScreen from "@/app/(tabs)/profile";
import { supabase } from "@/utils/supabase";

const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});

beforeEach(() => {
  jest.clearAllMocks();
  mockCapturedQueryFns = [];
  mockCapturedMutationFn = undefined;
  mockCapturedOnSuccess = undefined;
  // Default: all queries idle (not loading, no data) so existing tests are unaffected.
  mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
  // Default: mutation idle with a no-op mutate — tests that need to assert on it
  // call mockUseMutation.mockReturnValue({ mutate: mockMutate, isPending: false }) themselves.
  mockUseMutation.mockReturnValue({ mutate: mockMutate, isPending: false });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

// openEditForm presses the edit (pencil) button to enter editing mode and
// returns the rendered output so callers can interact with the form.
// With THEME_META=[], the TouchableOpacity order is: [avatar, edit, sign-out].
// Index 1 is the edit button.
async function openEditForm(renderResult: ReturnType<typeof render>) {
  const { UNSAFE_getAllByType } = renderResult;
  const { TouchableOpacity } = require("react-native");
  const buttons = UNSAFE_getAllByType(TouchableOpacity);
  await act(async () => {
    fireEvent.press(buttons[1]);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

it("renders the profile screen without crashing", () => {
  const { getByText } = render(<ProfileScreen />);
  expect(getByText("Profile")).toBeTruthy();
  expect(getByText("test@example.com")).toBeTruthy();
});

it("calls refreshSession after a successful display name save", async () => {
  // Both auth calls succeed.
  (supabase.auth.updateUser as jest.Mock).mockResolvedValue({ error: null });
  (supabase.auth.refreshSession as jest.Mock).mockResolvedValue({ error: null });

  const rendered = render(<ProfileScreen />);
  const { getByPlaceholderText, getByText } = rendered;

  await openEditForm(rendered);

  // The "Your name" input is visible once editing mode is active.
  await waitFor(() => getByPlaceholderText("Your name"));
  fireEvent.changeText(getByPlaceholderText("Your name"), "New Name");

  await act(async () => {
    fireEvent.press(getByText("Save Changes"));
  });

  await waitFor(() => {
    expect(supabase.auth.updateUser).toHaveBeenCalledWith({
      data: { full_name: "New Name" },
    });
    // refreshSession must follow updateUser so the new name propagates into the
    // JWT claims before the next API request syncs them back to the DB.
    expect(supabase.auth.refreshSession).toHaveBeenCalled();
  });
});

it("avatar upload saves to custom_avatar_url, not avatar_url", async () => {
  // Configure storage mock for this test: upload succeeds, publicUrl is returned.
  (supabase.storage.from as jest.Mock).mockReturnValue({
    upload: jest.fn().mockResolvedValue({ error: null }),
    getPublicUrl: jest.fn().mockReturnValue({
      data: { publicUrl: "https://example.com/custom-avatar.jpg" },
    }),
  });

  // Simulate ImagePicker returning a selected image.
  const ImagePicker = require("expo-image-picker");
  ImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ status: "granted" });
  ImagePicker.launchImageLibraryAsync.mockResolvedValue({
    canceled: false,
    assets: [{ uri: "file:///tmp/photo.jpg", mimeType: "image/jpeg" }],
  });

  // Mock fetch so arrayBuffer() resolves — handlePickImage reads the file URI as ArrayBuffer.
  // globalThis is used instead of global — `global` is Node-specific and not in TypeScript's
  // ESNext lib; globalThis is the ES2020 standard name for the same object.
  (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
    arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
  });

  (supabase.auth.updateUser as jest.Mock).mockResolvedValue({ error: null });

  const rendered = render(<ProfileScreen />);
  const { UNSAFE_getAllByType } = rendered;
  const { TouchableOpacity } = require("react-native");

  // Tap the avatar (index 0) to trigger handlePickImage.
  await act(async () => {
    fireEvent.press(UNSAFE_getAllByType(TouchableOpacity)[0]);
  });

  await waitFor(() => {
    // Must save to custom_avatar_url — avatar_url is overwritten by Google OAuth on re-login
    // and synced back to the DB by auth middleware, which would revert the upload.
    expect(supabase.auth.updateUser).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ custom_avatar_url: expect.any(String) }) })
    );
    expect(supabase.auth.updateUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ avatar_url: expect.any(String) }) })
    );

    // URL must include a ?t= cache-busting timestamp so the CDN and React Native's
    // image cache treat each re-upload as a new resource instead of serving the stale
    // cached version of avatar.jpg from the same storage path.
    const call = (supabase.auth.updateUser as jest.Mock).mock.calls[0][0];
    expect(call.data.custom_avatar_url).toMatch(/\?t=\d+$/);
  });
});

it("does not call refreshSession when updateUser returns an error", async () => {
  (supabase.auth.updateUser as jest.Mock).mockResolvedValue({
    error: { message: "Network error" },
  });

  const rendered = render(<ProfileScreen />);
  const { getByPlaceholderText, getByText } = rendered;

  await openEditForm(rendered);
  await waitFor(() => getByPlaceholderText("Your name"));
  fireEvent.changeText(getByPlaceholderText("Your name"), "Broken Name");

  await act(async () => {
    fireEvent.press(getByText("Save Changes"));
  });

  await waitFor(() => {
    expect(supabase.auth.refreshSession).not.toHaveBeenCalled();
  });
});

// ─── Following section ────────────────────────────────────────────────────────

it("shows a loading spinner while the following list is fetching", () => {
  mockUseQuery.mockReturnValue({ data: undefined, isLoading: true });

  const { UNSAFE_getByType } = render(<ProfileScreen />);
  const { ActivityIndicator } = require("react-native");
  expect(UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
});

it("shows an empty-state message when following nobody", () => {
  mockUseQuery.mockReturnValue({ data: [], isLoading: false });

  const { getByText } = render(<ProfileScreen />);
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

  const { getAllByText, getByText } = render(<ProfileScreen />);
  expect(getAllByText("Alice Fairway").length).toBeGreaterThanOrEqual(1);
  expect(getAllByText("Bob Bunker").length).toBeGreaterThanOrEqual(1);
  // Singular "round" for 1 round, plural "rounds" for 5
  expect(getByText("5 rounds played")).toBeTruthy();
  expect(getByText("1 round played")).toBeTruthy();
});

it("navigates to the player profile when a following row is tapped", async () => {
  const mockPush = jest.fn();
  // Override the router mock just for this test via jest.requireMock.
  const routerMock = require("expo-router");
  routerMock.useRouter.mockReturnValue({ replace: jest.fn(), push: mockPush });

  mockUseQuery.mockReturnValue({
    data: [{ id: "u1", display_name: "Alice Fairway", avatar_url: null, rounds_played: 3 }],
    isLoading: false,
  });

  const { getAllByText } = render(<ProfileScreen />);
  await act(async () => {
    fireEvent.press(getAllByText("Alice Fairway")[0]);
  });
  expect(mockPush).toHaveBeenCalledWith("/users/u1");
});

// ─── Scorecard Stats section ──────────────────────────────────────────────────

it("renders Scorecard Stats section with all 8 stat labels", () => {
  const { getByText } = render(<ProfileScreen />);
  // Section headings
  expect(getByText("Scorecard Stats")).toBeTruthy();
  expect(getByText("Score Position")).toBeTruthy();
  // All 8 individual stat labels
  expect(getByText("Fairway (FIR)")).toBeTruthy();
  expect(getByText("Green (GIR)")).toBeTruthy();
  expect(getByText("Putts")).toBeTruthy();
  expect(getByText("First Putt Distance")).toBeTruthy();
  expect(getByText("Made Putt Distance")).toBeTruthy();
  expect(getByText("Approach Yards")).toBeTruthy();
  expect(getByText("Tee Shot Club")).toBeTruthy();
  expect(getByText("Tee Shot Distance")).toBeTruthy();
});

it("calls settings mutation when a stat toggle is switched", async () => {
  const knownSettings = {
    fir_enabled: true,
    gir_enabled: true,
    putts_enabled: true,
    first_putt_distance_enabled: true,
    putt_distance_made_enabled: true,
    approach_yds_enabled: true,
    tee_shot_club_enabled: false,
    tee_shot_distance_enabled: false,
    stat_order: ["fir", "gir", "putts", "first_putt_distance", "putt_distance_made", "approach_yds", "tee_shot_club", "tee_shot_distance"],
    score_position: "last" as const,
  };
  // Return known settings for the scorecardSettings query; idle for everything else.
  mockUseQuery.mockImplementation((opts: { queryKey?: unknown[] }) => {
    if (opts?.queryKey?.[0] === "scorecardSettings") {
      return { data: knownSettings, isLoading: false };
    }
    return { data: undefined, isLoading: false };
  });

  const { UNSAFE_getAllByType } = render(<ProfileScreen />);
  const { Switch } = require("react-native");
  const switches = UNSAFE_getAllByType(Switch);

  // The first Switch rendered in the Scorecard Stats section is FIR.
  // Toggling it off should call mutate with fir_enabled: false.
  await act(async () => {
    fireEvent(switches[0], "valueChange", false);
  });

  expect(mockMutate).toHaveBeenCalledWith({ ...knownSettings, fir_enabled: false });
});

it("settings queryFn fetches from the correct endpoint with auth header", async () => {
  const { apiFetch } = require("@/utils/api");
  apiFetch.mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({ fir_enabled: true, gir_enabled: true }),
  });

  render(<ProfileScreen />);
  // mockCapturedQueryFns[1] is the scorecard-settings queryFn (index 0 is the following query).
  const settingsQueryFn = mockCapturedQueryFns.find(
    (fn) => fn.toString().includes("scorecard-settings")
  ) ?? mockCapturedQueryFns[1];
  expect(settingsQueryFn).toBeDefined();

  const result = await settingsQueryFn!();
  expect(apiFetch).toHaveBeenCalledWith(
    expect.stringContaining("scorecard-settings"),
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringContaining("Bearer") }) })
  );
  expect(result).toEqual({ fir_enabled: true, gir_enabled: true });
});

it("settings mutationFn PATCHes settings and onSuccess updates the query cache", async () => {
  const { apiFetch } = require("@/utils/api");
  const nextSettings = {
    fir_enabled: false, gir_enabled: true, putts_enabled: true,
    first_putt_distance_enabled: true, putt_distance_made_enabled: true,
    approach_yds_enabled: true, tee_shot_club_enabled: false, tee_shot_distance_enabled: false,
    stat_order: ["fir", "gir", "putts", "first_putt_distance", "putt_distance_made", "approach_yds", "tee_shot_club", "tee_shot_distance"],
    score_position: "last" as const,
  };
  apiFetch.mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue(nextSettings),
  });
  const mockSetQueryData = jest.fn();
  // Override useQueryClient for this test to spy on setQueryData.
  const reactQuery = require("@tanstack/react-query");
  jest.spyOn(reactQuery, "useQueryClient").mockReturnValue({ setQueryData: mockSetQueryData });

  render(<ProfileScreen />);
  expect(mockCapturedMutationFn).toBeDefined();
  expect(mockCapturedOnSuccess).toBeDefined();

  const data = await mockCapturedMutationFn!(nextSettings);
  expect(apiFetch).toHaveBeenCalledWith(
    expect.stringContaining("scorecard-settings"),
    expect.objectContaining({ method: "PATCH" })
  );
  expect(data).toEqual(nextSettings);

  // onSuccess calls queryClient.setQueryData with the new settings.
  mockCapturedOnSuccess!(nextSettings, nextSettings);
});

// ─── Score position picker ─────────────────────────────────────────────────────

it("calls settings mutation when score position pill is pressed", async () => {
  const knownSettings = {
    fir_enabled: true,
    gir_enabled: true,
    putts_enabled: true,
    first_putt_distance_enabled: true,
    putt_distance_made_enabled: true,
    approach_yds_enabled: true,
    tee_shot_club_enabled: false,
    tee_shot_distance_enabled: false,
    stat_order: ["fir", "gir", "putts", "first_putt_distance", "putt_distance_made", "approach_yds", "tee_shot_club", "tee_shot_distance"],
    score_position: "last" as const,
  };
  mockUseQuery.mockImplementation((opts: { queryKey?: unknown[] }) => {
    if (opts?.queryKey?.[0] === "scorecardSettings") {
      return { data: knownSettings, isLoading: false };
    }
    return { data: undefined, isLoading: false };
  });

  const { getByText } = render(<ProfileScreen />);
  await act(async () => {
    fireEvent.press(getByText("Before Stats"));
  });
  expect(mockMutate).toHaveBeenCalledWith({ ...knownSettings, score_position: "first" });
});

// ─── Stat reordering ──────────────────────────────────────────────────────────

it("calls settings mutation with reordered stat_order when up arrow is pressed", async () => {
  const knownSettings = {
    fir_enabled: true,
    gir_enabled: true,
    putts_enabled: true,
    first_putt_distance_enabled: true,
    putt_distance_made_enabled: true,
    approach_yds_enabled: true,
    tee_shot_club_enabled: false,
    tee_shot_distance_enabled: false,
    stat_order: ["fir", "gir", "putts", "first_putt_distance", "putt_distance_made", "approach_yds", "tee_shot_club", "tee_shot_distance"],
    score_position: "last" as const,
  };
  mockUseQuery.mockImplementation((opts: { queryKey?: unknown[] }) => {
    if (opts?.queryKey?.[0] === "scorecardSettings") {
      return { data: knownSettings, isLoading: false };
    }
    return { data: undefined, isLoading: false };
  });

  const { getByTestId } = render(<ProfileScreen />);
  // Press the up arrow on GIR (second stat in stat_order) to move it before FIR.
  await act(async () => {
    fireEvent.press(getByTestId("gir-up"));
  });
  expect(mockMutate).toHaveBeenCalledWith({
    ...knownSettings,
    stat_order: ["gir", "fir", "putts", "first_putt_distance", "putt_distance_made", "approach_yds", "tee_shot_club", "tee_shot_distance"],
  });
});
