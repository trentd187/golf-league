// __tests__/app/oauth-callback.test.tsx
// Tests for the web OAuth callback screen.
// Verifies that the screen redirects to /(tabs) when a session exists or the
// SIGNED_IN event fires, and does not redirect otherwise.

import React from "react";
import { render, waitFor } from "@testing-library/react-native";

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

// ─── Tests ────────────────────────────────────────────────────────────────────

import OAuthCallback from "@/app/oauth-callback";
import { supabase } from "@/utils/supabase";

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
