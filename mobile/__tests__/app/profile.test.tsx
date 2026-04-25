// __tests__/app/profile.test.tsx
// Tests for the ProfileScreen's name-save and avatar-upload flows.
//
// Covers:
//   - refreshSession is called after a successful display name save (bug fix:
//     without this the old JWT re-syncs the stale name back to the DB on the
//     next API request, making the change appear not to persist)
//   - refreshSession is NOT called when updateUser returns an error
//   - Avatar upload saves to custom_avatar_url (not avatar_url) so Google OAuth
//     re-logins cannot overwrite user-uploaded photos

import React from "react";
import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import { Alert } from "react-native";

// --- Mocks ---
// jest.mock() is hoisted before imports; variables from the outer scope are
// not yet defined inside factory functions, so we use jest.fn() directly.

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
  useAuth: () => ({ signOut: jest.fn() }),
}));

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

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }),
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
