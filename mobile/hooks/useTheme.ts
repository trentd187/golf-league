// hooks/useTheme.ts
// Convenience hook that returns the currently active Theme object.
//
// Usage in any component:
//   const t = useTheme();
//   return <View className={t.screen}><Text className={t.textPrimary}>Hello</Text></View>
//
// Why a separate hook instead of calling useThemeStore directly?
//   - One import instead of two (no need to import the store and write the selector).
//   - The selector (s) => s.theme means components only re-render when the theme changes,
//     not on any other future store mutations.

import { useThemeStore } from "@/stores/themeStore";
import { Theme } from "@/themes";

export function useTheme(): Theme {
  return useThemeStore((s) => s.theme);
}
