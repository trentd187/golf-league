// stores/themeStore.ts
// Zustand store that manages the active theme and persists the user's selection
// across app restarts using expo-secure-store.
//
// Why Zustand persist + SecureStore?
//   - `persist` middleware adds automatic save/load around the store state.
//   - expo-secure-store is an encrypted key-value store that survives app restarts.
//     It's the same adapter already used for Clerk tokens, so no new native module needed.
//   - Only `themeName` (a short string like "dark") is persisted — the full Theme object
//     is re-derived at runtime from THEMES[themeName], keeping stored data compact.
//
// Usage:
//   const theme = useThemeStore((s) => s.theme);    // prefer the useTheme() hook instead
//   const setTheme = useThemeStore((s) => s.setTheme);
//   setTheme("dark");

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import * as SecureStore from "expo-secure-store";
import { Theme, ThemeName, THEMES } from "@/themes";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ThemeState {
  themeName: ThemeName; // persisted to SecureStore
  theme: Theme;         // derived at runtime — NOT persisted
  setTheme: (name: ThemeName) => void;
}

// ─── SecureStore adapter ──────────────────────────────────────────────────────
// createJSONStorage expects { getItem, setItem, removeItem } with async signatures.
// The .catch() guards handle the rare case where SecureStore is unavailable
// (e.g. device encryption not set up) — we fall back to the default theme gracefully.
const secureStoreAdapter = createJSONStorage(() => ({
  getItem: (key: string): Promise<string | null> =>
    SecureStore.getItemAsync(key).catch(() => null),
  setItem: (key: string, value: string): Promise<void> =>
    SecureStore.setItemAsync(key, value).catch(() => {}),
  removeItem: (key: string): Promise<void> =>
    SecureStore.deleteItemAsync(key).catch(() => {}),
}));

// ─── Store ────────────────────────────────────────────────────────────────────

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      // Default to "light" on first launch (before SecureStore is read).
      // onRehydrateStorage below re-derives the correct theme after hydration.
      themeName: "light" as ThemeName,
      theme:     THEMES["light"],

      setTheme: (name: ThemeName) =>
        set({ themeName: name, theme: THEMES[name] }),
    }),
    {
      name: "theme-storage",
      storage: secureStoreAdapter,

      // Only write themeName to storage — not the full theme object or setTheme function.
      partialize: (state) => ({ themeName: state.themeName }),

      // After the persisted themeName is loaded back, re-derive the full Theme object.
      // At hydration time, state.theme is still the constructor default ("light").
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Guard against a stored name that's no longer valid (e.g. theme removed in update).
          if (!THEMES[state.themeName]) {
            state.themeName = "light";
          }
          state.theme = THEMES[state.themeName];
        }
      },
    }
  )
);
