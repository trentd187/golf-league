// __tests__/app/index.test.tsx
// Tests for the root index screen — session restoration, redirect routing, and
// stale refresh-token handling.

import React from "react";
import { render, waitFor, act } from "@testing-library/react-native";

// --- Mocks ---

const mockSignOut = jest.fn();
// onAuthStateChange captures the callback so tests can fire auth events manually.
let capturedAuthCallback: ((event: string, session: object | null) => void) | null = null;

jest.mock("@/utils/supabase", () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      signOut: jest.fn(),
      onAuthStateChange: jest.fn((cb: (event: string, session: object | null) => void) => {
        capturedAuthCallback = cb;
        return { data: { subscription: { unsubscribe: jest.fn() } } };
      }),
    },
  },
}));

const mockRedirect = jest.fn();
jest.mock("expo-router", () => ({
  Redirect: ({ href }: { href: string }) => {
    mockRedirect(href);
    return null;
  },
}));

// --- Imports (after mocks) ---

import Index from "@/app/index";
import { supabase } from "@/utils/supabase";

const getSessionMock = supabase.auth.getSession as jest.Mock;
const signOutMock = supabase.auth.signOut as jest.Mock;
const onAuthStateChangeMock = supabase.auth.onAuthStateChange as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  capturedAuthCallback = null;
  signOutMock.mockResolvedValue({});
  onAuthStateChangeMock.mockImplementation((cb: (event: string, session: object | null) => void) => {
    capturedAuthCallback = cb;
    return { data: { subscription: { unsubscribe: jest.fn() } } };
  });
});

it("redirects to /(tabs) when a valid session is found", async () => {
  getSessionMock.mockResolvedValue({
    data: { session: { access_token: "tok" } },
    error: null,
  });

  render(<Index />);

  await waitFor(() => {
    expect(mockRedirect).toHaveBeenCalledWith("/(tabs)");
  });
  expect(signOutMock).not.toHaveBeenCalled();
});

it("redirects to /sign-in when no session is stored", async () => {
  getSessionMock.mockResolvedValue({
    data: { session: null },
    error: null,
  });

  render(<Index />);

  await waitFor(() => {
    expect(mockRedirect).toHaveBeenCalledWith("/sign-in");
  });
  expect(signOutMock).not.toHaveBeenCalled();
});

it("calls signOut and redirects to /sign-in on a stale refresh token error", async () => {
  getSessionMock.mockResolvedValue({
    data: { session: null },
    error: { message: "Invalid Refresh Token: Refresh Token Not Found" },
  });

  render(<Index />);

  await waitFor(() => {
    expect(signOutMock).toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith("/sign-in");
  });
});

it("renders a stable view (not null) during the loading state", () => {
  // Never resolves — keeps the component in its initial loading state
  getSessionMock.mockReturnValue(new Promise(() => {}));

  const { toJSON } = render(<Index />);

  // Loading state must render something (View) so the native tree is stable
  expect(mockRedirect).not.toHaveBeenCalled();
  expect(toJSON()).not.toBeNull();
});

it("unsubscribes from onAuthStateChange on unmount", () => {
  const unsubscribe = jest.fn();
  onAuthStateChangeMock.mockImplementation((cb: (event: string, session: object | null) => void) => {
    capturedAuthCallback = cb;
    return { data: { subscription: { unsubscribe } } };
  });
  // Keep in loading state so nothing redirects before unmount
  getSessionMock.mockReturnValue(new Promise(() => {}));

  const { unmount } = render(<Index />);

  act(() => {
    unmount();
  });

  expect(unsubscribe).toHaveBeenCalled();
});
