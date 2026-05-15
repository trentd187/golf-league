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
// Usage:
//   const theme = useThemeStore((s) => s.theme);    // prefer the useTheme() hook instead
//   const setTheme = useThemeStore((s) => s.setTheme);
//   setTheme("dark");

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { platformStorage } from "@/utils/platformStorage";
import { Theme, ThemeName, THEMES } from "@/themes";

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
      // Default to "light" on first launch (before SecureStore is read).
      // onRehydrateStorage below re-derives the correct theme after hydration.
      themeName: "light" as ThemeName,
      theme:     THEMES["light"],
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
