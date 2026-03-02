// stores/themeStore.ts
// Zustand store that manages the active theme and persists the user's selection
// across app restarts using expo-secure-store.
//
// Why Zustand persist + SecureStore?
//   - Zustand's `persist` middleware adds automatic save/load around the store state.
//   - expo-secure-store is an encrypted key-value store available on both iOS and Android.
//     It survives app restarts and is appropriate for user preferences (even though theme
//     names aren't sensitive, it's the same adapter already used for Clerk tokens).
//   - We only persist `themeName` (the string key), not the full Theme object.
//     The full object is re-derived at runtime by looking up THEMES[themeName], which
//     avoids storing redundant data and ensures the stored value stays compact.
//
// Usage:
//   // Read current theme object (prefer the useTheme hook instead)
//   const theme = useThemeStore((s) => s.theme);
//
//   // Change theme
//   const setTheme = useThemeStore((s) => s.setTheme);
//   setTheme("dark");

import { create } from "zustand";
// `persist` wraps any Zustand store with automatic serialization to/from async storage.
// `createJSONStorage` creates a storage adapter from a factory function.
import { persist, createJSONStorage } from "zustand/middleware";
// SecureStore is Expo's encrypted key-value store.
import * as SecureStore from "expo-secure-store";
import { Theme, ThemeName, THEMES } from "@/themes";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ThemeState {
  // The active theme's string key — this is the only value written to SecureStore.
  themeName: ThemeName;
  // The full theme object, derived from themeName. NOT persisted; re-derived on load.
  theme: Theme;
  // Action to switch themes. Updates both themeName and the derived theme object.
  setTheme: (name: ThemeName) => void;
}

// ─── SecureStore adapter ──────────────────────────────────────────────────────
// Zustand persist expects a storage adapter with { getItem, setItem, removeItem }.
// expo-secure-store's API is async (returns Promises), which `createJSONStorage` supports.
// The `.catch(() => null)` / `.catch(() => {})` guards handle the rare case where
// SecureStore fails (e.g. device encryption not available) — we fall back gracefully
// to the default theme rather than crashing.
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
  // `persist` wraps the store creator with save/load logic.
  persist(
    // The store creator — receives `set` to update state.
    (set) => ({
      // Default to light theme on first launch (before SecureStore is read).
      // After hydration, `onRehydrateStorage` below re-derives the stored theme.
      themeName: "light" as ThemeName,
      theme:     THEMES["light"],

      // setTheme updates both the name (persisted) and the derived object (transient).
      setTheme: (name: ThemeName) =>
        set({ themeName: name, theme: THEMES[name] }),
    }),
    {
      // The key used to store data in SecureStore.
      name: "theme-storage",

      // Use our SecureStore adapter instead of the default localStorage.
      storage: secureStoreAdapter,

      // partialize controls WHAT gets written to storage.
      // We only persist `themeName` — a short string like "dark".
      // The full `theme` object and `setTheme` function are excluded.
      partialize: (state) => ({ themeName: state.themeName }),

      // onRehydrateStorage is called after the persisted data is loaded back.
      // At that point, `state.theme` is still the constructor default because
      // only `themeName` was stored. We re-derive the full Theme object here.
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Guard: if the persisted name is no longer a valid theme key (e.g. a theme
          // was removed between app versions), fall back gracefully to "light" rather
          // than setting state.theme to undefined and crashing.
          if (!THEMES[state.themeName]) {
            state.themeName = "light";
          }
          state.theme = THEMES[state.themeName];
        }
      },
    }
  )
);
