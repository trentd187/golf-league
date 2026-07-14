// __tests__/app/oauth-callback.test.tsx
// Tests for the web OAuth callback screen.
// Verifies that the screen redirects to /(tabs) when a session exists or the
// SIGNED_IN event fires, and does not redirect otherwise.

import React from "react";
import { render, waitFor, act } from "@testing-library/react-native";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

// onAuthStateChange captures the caller's callback so tests can fire events.
// capturedAuthCallback is set INSIDE the mock implementation (not at factory call
// time), so it's safe to declare it before jest.mock().
let capturedAuthCallback: ((event: string, session: object | null) => void) | null = null;

// All mock functions are defined with jest.fn() INSIDE the factory. Jest hoists
// mock factories above imports, so any outer `const mockFn = jest.fn()` would be
// undefined when the factory runs. Access them via the imported supabase object.
jest.mock("@/utils/supabase", () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      onAuthStateChange: jest.fn((cb: (event: string, session: object | null) => void) => {
        capturedAuthCallback = cb;
        return { data: { subscription: { unsubscribe: jest.fn() } } };
      }),
    },
  },
}));

jest.mock("@/utils/sentry", () => ({ reportAuthFailure: jest.fn() }));

// ─── Tests ────────────────────────────────────────────────────────────────────

import OAuthCallback from "@/app/oauth-callback";
import { supabase } from "@/utils/supabase";
import { reportAuthFailure } from "@/utils/sentry";

const getSessionMock = supabase.auth.getSession as jest.Mock;
const onAuthStateChangeMock = supabase.auth.onAuthStateChange as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  capturedAuthCallback = null;
  // Default: no session yet (code exchange still in progress).
  getSessionMock.mockResolvedValue({ data: { session: null } });
  // Re-capture the callback on each render since clearAllMocks resets the implementation.
  onAuthStateChangeMock.mockImplementation((cb: (event: string, session: object | null) => void) => {
    capturedAuthCallback = cb;
    return { data: { subscription: { unsubscribe: jest.fn() } } };
  });
});

it("redirects to /(tabs) when getSession already has a session (fast path)", async () => {
  getSessionMock.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });

  render(<OAuthCallback />);

  await waitFor(() => {
    expect(mockReplace).toHaveBeenCalledWith("/(tabs)/events");
  });
});

it("redirects to /(tabs) when SIGNED_IN event fires", async () => {
  render(<OAuthCallback />);

  // Wait for useEffect to run and register the auth listener before invoking it.
  await waitFor(() => expect(capturedAuthCallback).not.toBeNull());

  capturedAuthCallback?.("SIGNED_IN", { user: { id: "u1" } });

  await waitFor(() => {
    expect(mockReplace).toHaveBeenCalledWith("/(tabs)/events");
  });
});

it("does not redirect on INITIAL_SESSION with no session", async () => {
  render(<OAuthCallback />);

  await waitFor(() => expect(capturedAuthCallback).not.toBeNull());

  // Supabase fires INITIAL_SESSION before the code exchange completes — must not redirect.
  capturedAuthCallback?.("INITIAL_SESSION", null);

  await new Promise((r) => setTimeout(r, 50));
  expect(mockReplace).not.toHaveBeenCalled();
});

// ─── Regression: the exchange must have a terminal failure state ──────────────
//
// This screen was an ActivityIndicator with no error path and no timeout. If the PKCE
// exchange never completed — expired code, dropped network, a rejected getSession — SIGNED_IN
// never fired and the user watched the spinner forever, with nothing in Sentry.

it("shows a recoverable error (not an endless spinner) when getSession rejects", async () => {
  getSessionMock.mockRejectedValue(new Error("network down"));

  const { getByText } = render(<OAuthCallback />);

  await waitFor(() => expect(getByText("Sign-in didn't complete")).toBeTruthy());
  expect(reportAuthFailure).toHaveBeenCalledWith(
    expect.any(Error),
    expect.objectContaining({ stage: "oauth_callback_get_session", fatal: true }),
  );
});

it("gives up with an error after the exchange timeout rather than spinning forever", async () => {
  jest.useFakeTimers();
  try {
    // getSession resolves with no session and SIGNED_IN never fires — the stalled-exchange case.
    const { getByText } = render(<OAuthCallback />);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(21000);
    });

    expect(getByText("Sign-in didn't complete")).toBeTruthy();
    expect(reportAuthFailure).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ stage: "oauth_callback_timeout", fatal: true }),
    );
    expect(mockReplace).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it("does not fire the timeout after a successful redirect", async () => {
  jest.useFakeTimers();
  try {
    getSessionMock.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });

    render(<OAuthCallback />);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(30000);
    });

    expect(mockReplace).toHaveBeenCalledWith("/(tabs)/events");
    expect(reportAuthFailure).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it("unsubscribes from auth state changes on unmount", async () => {
  const mockUnsubscribe = jest.fn();
  onAuthStateChangeMock.mockImplementation((cb: (event: string, session: object | null) => void) => {
    capturedAuthCallback = cb;
    return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
  });

  const { unmount } = render(<OAuthCallback />);
  unmount();
  expect(mockUnsubscribe).toHaveBeenCalled();
});
