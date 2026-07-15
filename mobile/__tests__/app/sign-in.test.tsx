// __tests__/app/sign-in.test.tsx
// Tests for the sign-in screen's auth telemetry events.
// All external dependencies are mocked — no Supabase, no native modules needed.

import React from "react";
import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import { Alert } from "react-native";

// --- Mocks ---
// @sentry/react-native is auto-mocked by __mocks__/@sentry/react-native.js, so
// Sentry.logger.info/warn are jest.fn() spies we can assert on directly.

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
import * as Sentry from "@sentry/react-native";

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
    expect(Sentry.logger.info).toHaveBeenCalledWith("OTP email sent", {
      event: "auth.otp.sent",
    });
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
    expect(Sentry.logger.info).toHaveBeenCalledWith(
      "OTP verification succeeded",
      { event: "auth.otp.verified" }
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
    expect(Sentry.logger.warn).toHaveBeenCalledWith(
      "OTP verification failed",
      { event: "auth.otp.error", message: "Token has expired or is invalid" }
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

// ─── Failure telemetry + the "permanently disabled button" bug ────────────────
//
// The three ways a user fails to get INTO the app — a failed OTP send, a failed PKCE
// exchange, and a thrown (rather than returned) auth error — all logged NOTHING. The top of
// the funnel was the least observable part of the app.
//
// The thrown case was also a UX trap: supabase-js normally returns { error }, but a transport
// failure throws AuthRetryableFetchError. Without a try/finally, setLoading(false) never ran,
// so the button stayed disabled behind a spinner and the user could not even retry.

it("reports a failed OTP send — the send used to fail with no signal at all", async () => {
  (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValue({
    error: { message: "Rate limit exceeded" },
  });

  const { getByPlaceholderText, getByText } = render(<SignIn />);

  fireEvent.changeText(getByPlaceholderText("Email address"), "test@example.com");
  await act(async () => {
    fireEvent.press(getByText("Continue with Email"));
  });

  await waitFor(() => {
    expect(Sentry.logger.warn).toHaveBeenCalledWith("OTP email send failed", {
      event: "auth.otp.send_error",
      message: "Rate limit exceeded",
    });
  });
});

it("recovers when signInWithOtp THROWS: reports it and re-enables the button", async () => {
  (supabase.auth.signInWithOtp as jest.Mock).mockRejectedValue(
    new Error("Network request failed"),
  );

  const { getByPlaceholderText, getByText } = render(<SignIn />);

  fireEvent.changeText(getByPlaceholderText("Email address"), "test@example.com");
  await act(async () => {
    fireEvent.press(getByText("Continue with Email"));
  });

  await waitFor(() => {
    expect(Sentry.logger.warn).toHaveBeenCalledWith("OTP email send threw", {
      event: "auth.otp.send_error",
      message: "Network request failed",
    });
  });

  // The button is still there and still usable — it used to stay disabled behind a spinner
  // forever, because setLoading(false) was never reached.
  expect(getByText("Continue with Email")).toBeTruthy();
});

it("recovers when verifyOtp THROWS rather than returning an error", async () => {
  (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValue({ error: null });
  (supabase.auth.verifyOtp as jest.Mock).mockRejectedValue(new Error("Network request failed"));

  const { getByPlaceholderText, getByText } = render(<SignIn />);

  fireEvent.changeText(getByPlaceholderText("Email address"), "test@example.com");
  await act(async () => {
    fireEvent.press(getByText("Continue with Email"));
  });
  await waitFor(() => getByPlaceholderText("000000"));

  fireEvent.changeText(getByPlaceholderText("000000"), "123456");
  await act(async () => {
    fireEvent.press(getByText("Verify Code"));
  });

  await waitFor(() => {
    expect(Sentry.logger.warn).toHaveBeenCalledWith("OTP verification threw", {
      event: "auth.otp.error",
      message: "Network request failed",
    });
  });

  expect(getByText("Verify Code")).toBeTruthy();
});
