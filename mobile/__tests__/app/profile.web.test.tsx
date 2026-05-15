// __tests__/app/profile.web.test.tsx
// Tests the web-platform image picker branch in ProfileScreen.
// Platform.OS is set to 'web' in beforeAll so the document.createElement
// file-input path is exercised instead of the expo-image-picker native flow.

import React from "react";
import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import { Alert, Platform } from "react-native";

// Mutate Platform.OS to 'web' before tests run. profile.tsx reads Platform.OS
// inside handlePickImage (a function body), so the value at call-time is 'web'.
beforeAll(() => { (Platform as unknown as { OS: string }).OS = "web"; });
afterAll(() => { (Platform as unknown as { OS: string }).OS = "ios"; });

// --- document mock ---
// Captures the mock input element so tests can inspect properties and invoke onchange.

const mockInputEl = {
  type: "",
  accept: "",
  onchange: null as ((e: unknown) => void) | null,
  click: jest.fn(),
};

(globalThis as unknown as Record<string, unknown>).document = {
  createElement: jest.fn(() => mockInputEl),
};

// --- Mocks ---

const mockUseQuery = jest.fn();
const mockMutate = jest.fn();
const mockUseMutation = jest.fn();
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
    storage: {
      from: jest.fn(),
    },
  },
}));

jest.mock("expo-router", () => ({
  useRouter: jest.fn(() => ({ replace: jest.fn(), push: jest.fn() })),
}));

// Mocked but not exercised — web branch returns before reaching ImagePicker.
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

jest.mock("@/stores/themeStore", () => ({
  useThemeStore: (selector: (s: unknown) => unknown) =>
    selector({ themeName: "light", setTheme: jest.fn() }),
}));

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

// --- Imports (after mocks) ---

import ProfileScreen from "@/app/(tabs)/profile";
import { supabase } from "@/utils/supabase";

const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});

beforeEach(() => {
  jest.clearAllMocks();
  mockCapturedQueryFns = [];
  mockCapturedMutationFn = undefined;
  mockCapturedOnSuccess = undefined;
  mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
  mockUseMutation.mockReturnValue({ mutate: mockMutate, isPending: false });
  // Restore document.createElement mock after clearAllMocks resets it.
  (globalThis as unknown as Record<string, unknown>).document = {
    createElement: jest.fn(() => mockInputEl),
  };
  // Reset input state between tests.
  mockInputEl.type = "";
  mockInputEl.accept = "";
  mockInputEl.onchange = null;
  mockInputEl.click.mockReset();
});

// --- Tests ---

it("creates a file input element and clicks it when the avatar button is pressed", async () => {
  const rendered = render(<ProfileScreen />);
  const { UNSAFE_getAllByType } = rendered;
  const { TouchableOpacity } = require("react-native");

  // Avatar is the first TouchableOpacity (with THEME_META=[] the order is: avatar, edit, sign-out).
  await act(async () => {
    fireEvent.press(UNSAFE_getAllByType(TouchableOpacity)[0]);
  });

  const docMock = (globalThis as unknown as { document: { createElement: jest.Mock } }).document;
  expect(docMock.createElement).toHaveBeenCalledWith("input");
  expect(mockInputEl.type).toBe("file");
  expect(mockInputEl.accept).toBe("image/*");
  expect(mockInputEl.click).toHaveBeenCalled();
});

it("uploads the file to Supabase Storage when a file is selected", async () => {
  (supabase.storage.from as jest.Mock).mockReturnValue({
    upload: jest.fn().mockResolvedValue({ error: null }),
    getPublicUrl: jest.fn().mockReturnValue({
      data: { publicUrl: "https://example.com/web-avatar.jpg" },
    }),
  });
  (supabase.auth.updateUser as jest.Mock).mockResolvedValue({ error: null });

  const rendered = render(<ProfileScreen />);
  const { UNSAFE_getAllByType } = rendered;
  const { TouchableOpacity } = require("react-native");

  await act(async () => {
    fireEvent.press(UNSAFE_getAllByType(TouchableOpacity)[0]);
  });

  // Simulate file selection by invoking the assigned onchange handler.
  const mockFile = {
    type: "image/png",
    arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
  };

  await act(async () => {
    await mockInputEl.onchange?.({ target: { files: [mockFile] } });
  });

  await waitFor(() => {
    expect(supabase.auth.updateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ custom_avatar_url: expect.any(String) }),
      })
    );
  });
});

it("does not invoke expo-image-picker on web", async () => {
  const ImagePicker = require("expo-image-picker");
  const rendered = render(<ProfileScreen />);
  const { UNSAFE_getAllByType } = rendered;
  const { TouchableOpacity } = require("react-native");

  await act(async () => {
    fireEvent.press(UNSAFE_getAllByType(TouchableOpacity)[0]);
  });

  expect(ImagePicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
});
