// __tests__/app/sign-in.web.test.tsx
// Tests the web-platform Google OAuth branch in the sign-in screen.
// Platform.OS is set to 'web' in beforeAll so sign-in.tsx reads 'web'
// inside handleGoogleOAuth at call time.

import React from "react";
import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import { Alert, Platform } from "react-native";

// Mutate Platform.OS to 'web' before tests run. sign-in.tsx reads Platform.OS
// inside handleGoogleOAuth (a function body), so the value at call-time is 'web'.
// Each test file runs in its own Jest worker with a fresh module registry,
// so this does not affect other test files.
beforeAll(() => { (Platform as unknown as { OS: string }).OS = "web"; });
afterAll(() => { (Platform as unknown as { OS: string }).OS = "ios"; });

// window.location.origin is used to build the OAuth redirectTo URL on web.
(globalThis as unknown as Record<string, unknown>).window = {
  location: { origin: "https://golf-web.up.railway.app" },
};

// --- Mocks ---

const mockInfo = jest.fn();
const mockWarn = jest.fn();

jest.mock("@/utils/telemetry", () => ({
  getTelemetryClient: () => ({
    info: mockInfo,
    warn: mockWarn,
    error: jest.fn(),
    setTokenGetter: jest.fn(),
  }),
}));

jest.mock("@/utils/supabase", () => ({
  supabase: {
    auth: {
      signInWithOtp: jest.fn(),
      verifyOtp: jest.fn(),
      signInWithOAuth: jest.fn(),
      exchangeCodeForSession: jest.fn(),
    },
  },
}));

jest.mock("expo-web-browser", () => ({
  maybeCompleteAuthSession: jest.fn(),
  openAuthSessionAsync: jest.fn(),
}));

jest.mock("expo-auth-session", () => ({
  makeRedirectUri: jest.fn(() => "golfstuffinhere://oauth-callback"),
}));

const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    surface: "",
    textSecondary: "",
    textTertiary: "",
    textPrimary: "",
    divider: "",
    borderInput: "",
    primaryBg: "",
    primaryBgDisabled: "",
    colors: { tabBarInactive: "#ccc" },
  }),
}));

// --- Imports (after mocks) ---

import SignIn from "@/app/sign-in";
import { supabase } from "@/utils/supabase";

const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});

beforeEach(() => {
  jest.clearAllMocks();
  (supabase.auth.signInWithOAuth as jest.Mock).mockResolvedValue({ error: null });
});

// --- Tests ---

it("calls signInWithOAuth with redirectTo pointing to /oauth-callback on web", async () => {
  const { getByText } = render(<SignIn />);

  await act(async () => {
    fireEvent.press(getByText("Continue with Google"));
  });

  await waitFor(() => {
    expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: "https://golf-web.up.railway.app/oauth-callback" },
    });
  });
});

it("logs a warn and shows an alert when web signInWithOAuth returns an error", async () => {
  (supabase.auth.signInWithOAuth as jest.Mock).mockResolvedValue({
    error: { message: "OAuth provider unavailable" },
  });

  const { getByText } = render(<SignIn />);

  await act(async () => {
    fireEvent.press(getByText("Continue with Google"));
  });

  await waitFor(() => {
    expect(mockWarn).toHaveBeenCalledWith(
      "auth.google.error",
      "Google OAuth sign-in failed",
      { message: "OAuth provider unavailable" }
    );
    expect(alertSpy).toHaveBeenCalledWith(
      "Something went wrong",
      "OAuth provider unavailable",
      [{ text: "OK" }]
    );
  });
});

it("does not invoke expo-web-browser on web", async () => {
  const WebBrowser = require("expo-web-browser");
  const { getByText } = render(<SignIn />);

  await act(async () => {
    fireEvent.press(getByText("Continue with Google"));
  });

  await waitFor(() => {
    expect(supabase.auth.signInWithOAuth).toHaveBeenCalled();
  });

  expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
});
