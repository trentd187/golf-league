// hooks/useTheme.ts
// Convenience hook that returns the currently active Theme object.
//
// Usage in any component:
//   import { useTheme } from "@/hooks/useTheme";
//
//   export default function MyScreen() {
//     const t = useTheme();
//     return (
//       <View className={t.screen}>
//         <Text className={t.textPrimary}>Hello</Text>
//       </View>
//     );
//   }
//
// Why a separate hook instead of using useThemeStore directly?
//   - Cleaner import: one line instead of two (no need to import the store AND
//     write the selector each time).
//   - Selector optimization: using (s) => s.theme instead of selecting the whole
//     store means components only re-render when the theme object changes, not on
//     any other store mutation (e.g. if we add unrelated state to the store later).

import { useThemeStore } from "@/stores/themeStore";
import { Theme } from "@/themes";

// useTheme returns the full Theme object for the currently selected theme.
// Components can then use any slot: t.screen, t.textPrimary, t.primaryBg, etc.
export function useTheme(): Theme {
  // The selector (s) => s.theme returns only the theme object.
  // Zustand's shallow equality check means this component re-renders only
  // when the theme object reference changes (i.e. when setTheme is called).
  return useThemeStore((s) => s.theme);
}
