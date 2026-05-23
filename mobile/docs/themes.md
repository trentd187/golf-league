# Theme System

The app supports 3 switchable themes (Light, Dark, High Contrast) persisted across restarts in SecureStore. **All new screens and components must use theme tokens, not hardcoded color classes.**

## Architecture — three layers

| Layer | File | Role |
|---|---|---|
| Data | `themes/index.ts` | 4 static theme objects with all Tailwind class strings as literals |
| State | `stores/themeStore.ts` | Zustand `persist` store; saves only `themeName`, derives full `Theme` object |
| Consumption | `hooks/useTheme.ts` | `useTheme()` hook used in every screen/component |

## Usage

```tsx
import { useTheme } from "@/hooks/useTheme";

function MyScreen() {
  const t = useTheme();
  return (
    <View className={`flex-1 ${t.screen}`}>
      <Text className={t.textPrimary}>Hello</Text>
    </View>
  );
}
```

## Theme slots

| Slot | Purpose |
|---|---|
| `t.screen` | Full-page `View` background |
| `t.surface` | Cards, modals, bottom sheets |
| `t.surfaceSunken` | `TextInput` background (inset feel) |
| `t.border` | Card/container border |
| `t.divider` | `border-b` between list rows |
| `t.borderInput` | `TextInput` border |
| `t.textPrimary` | Headings, important text |
| `t.textSecondary` | Body/supporting text |
| `t.textTertiary` | Muted hints, form labels, section labels |
| `t.primaryBg` | Primary action button background |
| `t.primaryBgDisabled` | Primary button while loading/pending |
| `t.colors.tabBarActive` | Hex — for `Ionicons color`, `ActivityIndicator color`, inline styles |
| `t.colors.tabBarInactive` | Hex — for secondary icons, `placeholderTextColor` |

## Tailwind JIT constraint — critical rule

All Tailwind class strings must exist as **literal text** in scanned source files. `themes/index.ts` holds all the literal class strings and is included in the `tailwind.config.js` content paths. Never construct class names dynamically (e.g., no `` `text-${color}-500` ``). At runtime, components simply pick which pre-scanned string to use.

## Required overrides

- `placeholderTextColor` on every `TextInput`: NativeWind can't control placeholder color via `className`. Always add `placeholderTextColor={t.colors.tabBarInactive}`.
- `Ionicons` and `ActivityIndicator` always need hex: `color={t.colors.tabBarActive}` or `color={t.colors.tabBarInactive}`.
- Inline style required for themed hex on `Text` (e.g. iOS date picker "Done"):
  ```tsx
  // eslint-disable-next-line react-native/no-inline-styles
  <Text style={{ color: t.colors.tabBarActive }}>Done</Text>
  ```

## What is NEVER themed (always hardcoded categorical/brand colors)

- Event type badge colors (league=blue, tournament=amber, casual=gray)
- Status chip colors (upcoming=sky, active=green, completed=gray, cancelled=red)
- Role badge colors (organizer=green-100/green-700)
- Round status chip colors
- OAuth buttons (Google/Facebook/Apple brand colors)
- Sign-out button (always `bg-red-50 border-red-200 text-red-600`)
- Error text/borders (always `text-red-500` / `border-red-400`)
- Member initials avatars (always `bg-green-100 text-green-700`)
- App title "Golf Stuff In Here" (always `text-green-700`)
- `bg-black/40` modal backdrop overlay

## Theme switching UI

Lives in `app/(tabs)/profile.tsx` — pill buttons using `THEME_META` from `themes/index.ts` and `useThemeStore` from `stores/themeStore.ts`:

```tsx
import { useThemeStore } from "@/stores/themeStore";
import { THEME_META } from "@/themes";

// IMPORTANT: use two separate calls, not one selector returning an object.
// A selector like (s) => ({ themeName: s.themeName, setTheme: s.setTheme }) creates
// a new object on every render, which breaks React 19's useSyncExternalStore caching
// and causes an infinite re-render loop.
const themeName = useThemeStore((s) => s.themeName);
const setTheme  = useThemeStore((s) => s.setTheme);
```
