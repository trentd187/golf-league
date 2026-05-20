// __tests__/app/_layout.test.tsx
// Tests for the TelemetrySetup component in app/_layout.tsx.
// Focuses on the web.navigation logging behaviour: fires on mount (landing page)
// and on every subsequent route change, but is silent on native platforms.

import React from "react";
import { render } from "@testing-library/react-native";
import { Platform } from "react-native";

// Set Platform.OS to "web" before the module loads so the web-only guards are active.
// Reset to "ios" after all tests so other test suites are unaffected.
// This mirrors the pattern used in profile.web.test.tsx.
beforeAll(() => {
  (Platform as unknown as { OS: string }).OS = "web";
});
afterAll(() => {
  (Platform as unknown as { OS: string }).OS = "ios";
});

// --- Mocks ---

const mockInfo = jest.fn();
const mockSetTokenGetter = jest.fn();

jest.mock("@/utils/telemetry", () => ({
  getTelemetryClient: () => ({
    setTokenGetter: mockSetTokenGetter,
    info: mockInfo,
    flush: jest.fn(),
  }),
}));

jest.mock("@/utils/tracing", () => ({ initWebTracing: jest.fn() }));

jest.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ getToken: jest.fn() }),
}));

// Stub ErrorBoundary so its NativeWind/css-interop imports don't run during this test.
jest.mock("@/components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

// Controllable spy: tests update the return value to simulate route changes.
const mockUsePathname = jest.fn().mockReturnValue("/");

jest.mock("expo-router", () => ({
  Stack: () => null,
  usePathname: () => mockUsePathname(),
}));

import { TelemetrySetup } from "@/app/_layout";

beforeEach(() => {
  jest.clearAllMocks();
  mockUsePathname.mockReturnValue("/");
});

describe("TelemetrySetup — web.navigation logging", () => {
  it("logs web.navigation with the initial pathname on mount", () => {
    render(<TelemetrySetup />);
    expect(mockInfo).toHaveBeenCalledWith("web.navigation", "/");
  });

  it("logs web.navigation with the new pathname when the route changes", () => {
    const { rerender } = render(<TelemetrySetup />);
    mockInfo.mockClear();

    mockUsePathname.mockReturnValue("/events");
    rerender(<TelemetrySetup />);

    expect(mockInfo).toHaveBeenCalledWith("web.navigation", "/events");
  });

  it("does not re-log web.navigation when the pathname is unchanged on re-render", () => {
    const { rerender } = render(<TelemetrySetup />);
    mockInfo.mockClear();

    // Same path — useEffect dependency unchanged, should not fire again.
    rerender(<TelemetrySetup />);

    expect(mockInfo).not.toHaveBeenCalledWith("web.navigation", "/");
  });

  it("logs web.navigation for each distinct route in a multi-step navigation", () => {
    const { rerender } = render(<TelemetrySetup />);

    mockUsePathname.mockReturnValue("/events");
    rerender(<TelemetrySetup />);

    mockUsePathname.mockReturnValue("/events/123");
    rerender(<TelemetrySetup />);

    // web.session.start (mount) + 3 navigation events = 4 total info calls.
    expect(mockInfo).toHaveBeenCalledTimes(4);
    expect(mockInfo).toHaveBeenCalledWith("web.navigation", "/");
    expect(mockInfo).toHaveBeenCalledWith("web.navigation", "/events");
    expect(mockInfo).toHaveBeenCalledWith("web.navigation", "/events/123");
  });
});
