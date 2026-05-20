// __tests__/app/sign-in.test.tsx
// Tests for the sign-in screen's auth telemetry events.
// All external dependencies are mocked — no Supabase, no native modules needed.

import React from "react";
import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import { Alert } from "react-native";

// --- Mocks ---
// jest.mock() is hoisted before imports, so mock factories must use jest.fn()
// directly — variables declared in the outer test scope are not yet defined.

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

// Supabase auth methods are mocked as jest.fn() stubs within the factory.
// Tests customise their return values via the imported supabase object.
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
const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
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

// --- Imports (after mocks so the mocked versions are used) ---

import SignIn from "@/app/sign-in";
import { supabase } from "@/utils/supabase";

const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});

beforeEach(() => {
  jest.clearAllMocks();
});

it("renders the sign-in screen without crashing", () => {
  const { getByText } = render(<SignIn />);
  expect(getByText("Continue with Google")).toBeTruthy();
  expect(getByText("Continue with Email")).toBeTruthy();
});

it("shows the Terms of Service and Privacy Policy links on the initial step", () => {
  const { getByText } = render(<SignIn />);
  expect(getByText("Terms of Service")).toBeTruthy();
  expect(getByText("Privacy Policy")).toBeTruthy();
});

it("navigates to /terms when the Terms of Service link is pressed", () => {
  const { getByLabelText } = render(<SignIn />);
  fireEvent.press(getByLabelText("Terms of Service"));
  expect(mockPush).toHaveBeenCalledWith("/terms");
});

it("navigates to /privacy when the Privacy Policy link is pressed", () => {
  const { getByLabelText } = render(<SignIn />);
  fireEvent.press(getByLabelText("Privacy Policy"));
  expect(mockPush).toHaveBeenCalledWith("/privacy");
});

it("hides the legal links during OTP code entry", async () => {
  (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValue({ error: null });

  const { getByPlaceholderText, getByText, queryByLabelText } = render(<SignIn />);

  fireEvent.changeText(getByPlaceholderText("Email address"), "test@example.com");
  await act(async () => {
    fireEvent.press(getByText("Continue with Email"));
  });
  await waitFor(() => getByPlaceholderText("000000"));

  expect(queryByLabelText("Terms of Service")).toBeNull();
  expect(queryByLabelText("Privacy Policy")).toBeNull();
});

it("calls info telemetry when OTP email is sent successfully", async () => {
  (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValue({ error: null });

  const { getByPlaceholderText, getByText } = render(<SignIn />);

  fireEvent.changeText(getByPlaceholderText("Email address"), "test@example.com");
  await act(async () => {
    fireEvent.press(getByText("Continue with Email"));
  });

  await waitFor(() => {
    expect(mockInfo).toHaveBeenCalledWith("auth.otp.sent", "OTP email sent");
  });
});

it("calls info telemetry on successful OTP verification", async () => {
  (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValue({ error: null });
  (supabase.auth.verifyOtp as jest.Mock).mockResolvedValue({ error: null });

  const { getByPlaceholderText, getByText } = render(<SignIn />);

  // Step 1 — send OTP to transition to code-entry state
  fireEvent.changeText(getByPlaceholderText("Email address"), "test@example.com");
  await act(async () => {
    fireEvent.press(getByText("Continue with Email"));
  });

  // Step 2 — enter code and verify
  await waitFor(() => getByPlaceholderText("000000"));
  fireEvent.changeText(getByPlaceholderText("000000"), "123456");
  await act(async () => {
    fireEvent.press(getByText("Verify Code"));
  });

  await waitFor(() => {
    expect(mockInfo).toHaveBeenCalledWith(
      "auth.otp.verified",
      "OTP verification succeeded"
    );
  });
});

it("calls warn telemetry on failed OTP verification", async () => {
  (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValue({ error: null });
  (supabase.auth.verifyOtp as jest.Mock).mockResolvedValue({
    error: { message: "Token has expired or is invalid" },
  });

  const { getByPlaceholderText, getByText } = render(<SignIn />);

  fireEvent.changeText(getByPlaceholderText("Email address"), "test@example.com");
  await act(async () => {
    fireEvent.press(getByText("Continue with Email"));
  });

  await waitFor(() => getByPlaceholderText("000000"));
  fireEvent.changeText(getByPlaceholderText("000000"), "000000");
  await act(async () => {
    fireEvent.press(getByText("Verify Code"));
  });

  await waitFor(() => {
    expect(mockWarn).toHaveBeenCalledWith(
      "auth.otp.error",
      "OTP verification failed",
      { message: "Token has expired or is invalid" }
    );
  });
});

it("shows an alert when OTP send fails", async () => {
  (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValue({
    error: { message: "Rate limit exceeded" },
  });

  const { getByPlaceholderText, getByText } = render(<SignIn />);

  fireEvent.changeText(getByPlaceholderText("Email address"), "test@example.com");
  await act(async () => {
    fireEvent.press(getByText("Continue with Email"));
  });

  await waitFor(() => {
    expect(alertSpy).toHaveBeenCalledWith(
      "Something went wrong",
      "Rate limit exceeded",
      [{ text: "OK" }]
    );
  });
});

it("returns to email entry when 'Use a different email' is pressed", async () => {
  (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValue({ error: null });

  const { getByPlaceholderText, getByText, queryByPlaceholderText } = render(<SignIn />);

  // Transition to code-entry state
  fireEvent.changeText(getByPlaceholderText("Email address"), "test@example.com");
  await act(async () => {
    fireEvent.press(getByText("Continue with Email"));
  });
  await waitFor(() => getByPlaceholderText("000000"));

  // Go back
  await act(async () => {
    fireEvent.press(getByText("Use a different email"));
  });

  await waitFor(() => {
    expect(queryByPlaceholderText("000000")).toBeNull();
    expect(getByPlaceholderText("Email address")).toBeTruthy();
  });
});
