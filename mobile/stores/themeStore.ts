// stores/themeStore.ts
// Zustand store that manages the active theme and persists the user's selection
// across app restarts.
//
// Why Zustand persist + platformStorage?
//   - `persist` middleware adds automatic save/load around the store state.
//   - platformStorage uses expo-secure-store on native (encrypted) and localStorage
//     on web (plaintext — theme preference is not sensitive data).
//   - Only `themeName` (a short string like "dark") is persisted — the full Theme object
//     is re-derived at runtime from THEMES[themeName], keeping stored data compact.
//
// Flash prevention: SecureStore.getItem() (synchronous, SDK 47+) is called at
// module initialization time so the store is created with the correct theme on its
// very first render instead of always starting at "light" and then correcting.
//
// Usage:
//   const theme = useThemeStore((s) => s.theme);    // prefer the useTheme() hook instead
//   const setTheme = useThemeStore((s) => s.setTheme);
//   setTheme("dark");

import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { platformStorage } from "@/utils/platformStorage";
import { Theme, ThemeName, THEMES } from "@/themes";

// ─── Sync boot read ───────────────────────────────────────────────────────────
// Read the persisted theme before any component renders. On web SecureStore is
// unavailable, so we fall back to "light". Any parse failure also falls back.
function readStoredThemeName(): ThemeName {
  if (Platform.OS === "web") return "light";
  try {
    const raw = SecureStore.getItem("theme-storage");
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: { themeName?: string } };
      const name = parsed?.state?.themeName;
      if (name && THEMES[name as ThemeName]) return name as ThemeName;
    }
  } catch {}
  return "light";
}

const bootThemeName = readStoredThemeName();

// ─── Types ────────────────────────────────────────────────────────────────────

interface ThemeState {
  themeName: ThemeName; // persisted via platformStorage
  theme: Theme;         // derived at runtime — NOT persisted
  setTheme: (name: ThemeName) => void;
  _hasHydrated: boolean; // true once storage read completes; false during the brief startup window
}

// ─── Storage adapter ──────────────────────────────────────────────────────────
// createJSONStorage expects { getItem, setItem, removeItem } with async signatures.
// The .catch() guards handle the rare case where storage is unavailable — we fall
// back to the default theme gracefully.
const storageAdapter = createJSONStorage(() => ({
  getItem: (key: string): Promise<string | null> =>
    platformStorage.getItemAsync(key).catch(() => null),
  setItem: (key: string, value: string): Promise<void> =>
    platformStorage.setItemAsync(key, value).catch(() => {}),
  removeItem: (key: string): Promise<void> =>
    platformStorage.deleteItemAsync(key).catch(() => {}),
}));

// ─── Store ────────────────────────────────────────────────────────────────────

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      // Initialized from the sync boot read above — already the correct theme.
      // onRehydrateStorage will confirm and set _hasHydrated without a visible redraw.
      themeName: bootThemeName,
      theme:     THEMES[bootThemeName],
      _hasHydrated: false,

      setTheme: (name: ThemeName) =>
        set({ themeName: name, theme: THEMES[name] }),
    }),
    {
      name: "theme-storage",
      storage: storageAdapter,

      // Only write themeName to storage — not the full theme object, setTheme, or _hasHydrated.
      partialize: (state) => ({ themeName: state.themeName }),

      // After the persisted themeName is loaded back, re-derive the full Theme object
      // and mark hydration complete.
      //
      // Why useThemeStore.setState() instead of direct state mutation?
      // Zustand's persist middleware calls set(rehydratedState) BEFORE this callback fires,
      // so `state` here is a reference to the already-committed store value. Mutating it
      // directly does NOT trigger React re-renders — the dispatch already happened.
      // Calling setState() issues a new dispatch so subscribers (e.g. the tab bar in
      // _layout.tsx) re-render with the restored theme instead of staying on the "light" default.
      onRehydrateStorage: () => (state) => {
        const name = state && THEMES[state.themeName] ? state.themeName : "light";
        useThemeStore.setState({ themeName: name, theme: THEMES[name], _hasHydrated: true });
      },
    }
  )
);
