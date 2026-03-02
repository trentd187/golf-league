// themes/index.ts
// Defines the 3 UI themes available in the app: Light, Dark, and Grey.
//
// Architecture note — why all class strings must live here as literals:
//   Tailwind's JIT (Just-In-Time) compiler scans source files at BUILD TIME to
//   discover which utility classes are actually used, then generates only those
//   styles in the final CSS bundle. Any class string that doesn't appear as a
//   literal in a scanned file will NOT be generated, even if it is constructed
//   at runtime from smaller pieces.
//
//   By defining every theme class string as a literal value in this file
//   (which is included in tailwind.config.js `content` paths), we guarantee
//   all theme classes are captured. At runtime, components simply select which
//   pre-scanned string to use — no dynamic string construction.
//
// How themes are consumed:
//   import { useTheme } from "@/hooks/useTheme";
//   const t = useTheme();
//   <View className={t.screen}>
//   <Text className={t.textPrimary}>

// ─── Types ────────────────────────────────────────────────────────────────────

// ThemeName is the union of all valid theme identifier strings.
// Used as the persisted key in SecureStore and as the THEMES map key.
export type ThemeName = "light" | "dark" | "grey";

// Theme defines the shape of a single theme object.
// Every UI surface in the app maps to one of these slots.
export interface Theme {
  // ── Background classes ────────────────────────────────────────────
  // Full-page (screen) background — wraps the whole ScrollView / SafeAreaView
  screen: string;
  // Card / modal / bottom-sheet background — lighter than screen so cards appear elevated
  surface: string;
  // Text input background — same tone as screen so inputs look "sunken" relative to the card
  surfaceSunken: string;

  // ── Border classes ────────────────────────────────────────────────
  // Card and container borders
  border: string;
  // Subtle `border-b` divider between list rows
  divider: string;
  // TextInput border (may be replaced by red on error)
  borderInput: string;

  // ── Text classes ──────────────────────────────────────────────────
  // Headings and primary content text
  textPrimary: string;
  // Body / supporting text
  textSecondary: string;
  // Muted hints, section labels, placeholders
  textTertiary: string;

  // ── Button background classes ─────────────────────────────────────
  // Primary action button (e.g. "Create Event", "Save Changes")
  primaryBg: string;
  // Primary button while loading or disabled (pending state)
  primaryBgDisabled: string;

  // ── Hex color values ──────────────────────────────────────────────
  // These cannot use Tailwind className because they're passed as JS props
  // to React Navigation (tabBarActiveTintColor, tabBarStyle, etc.) and to
  // Ionicons' `color` prop — both of which require hex strings, not class names.
  colors: {
    tabBarBg: string;       // Tab bar background
    tabBarBorder: string;   // Tab bar top border
    tabBarActive: string;   // Active tab icon / text tint
    tabBarInactive: string; // Inactive tab icon / text tint
  };
}

// ─── Theme definitions ────────────────────────────────────────────────────────
// IMPORTANT: All strings below must remain literal (no template literals,
// no concatenation) so the Tailwind JIT scanner captures every class.

// Light — the original app look: white cards, gray-50 background, green-700 brand
const light: Theme = {
  screen:           "bg-gray-50",
  surface:          "bg-white",
  // surfaceSunken = same as screen → on a white card, this shade looks inset
  surfaceSunken:    "bg-gray-50",
  border:           "border-gray-100",
  divider:          "border-gray-100",
  borderInput:      "border-gray-300",
  textPrimary:      "text-gray-900",
  textSecondary:    "text-gray-600",
  textTertiary:     "text-gray-400",
  primaryBg:        "bg-green-700",
  primaryBgDisabled:"bg-green-400",
  colors: {
    tabBarBg:       "#ffffff",
    tabBarBorder:   "#e5e7eb",
    tabBarActive:   "#15803d",
    tabBarInactive: "#9ca3af",
  },
};

// Dark — deep gray background, elevated cards, green-600 brand
const dark: Theme = {
  screen:           "bg-gray-900",
  surface:          "bg-gray-800",
  // surfaceSunken = same as screen → on a gray-800 card, gray-900 looks inset
  surfaceSunken:    "bg-gray-900",
  border:           "border-gray-700",
  divider:          "border-gray-700",
  borderInput:      "border-gray-600",
  textPrimary:      "text-gray-100",
  textSecondary:    "text-gray-300",
  textTertiary:     "text-gray-500",
  primaryBg:        "bg-green-600",
  primaryBgDisabled:"bg-green-800",
  colors: {
    tabBarBg:       "#111827",
    tabBarBorder:   "#374151",
    tabBarActive:   "#16a34a",
    tabBarInactive: "#6b7280",
  },
};

// Grey — neutral palette, one step darker than before.
//   screen = neutral-300, surface = neutral-200 (lighter = elevated cards),
//   surfaceSunken = neutral-300 (matches screen → appears inset on neutral-200 cards).
//   Near-black (neutral-900) primary actions keep contrast high.
const grey: Theme = {
  screen:           "bg-neutral-300",
  surface:          "bg-neutral-200",
  // surfaceSunken matches screen so inputs look sunken relative to the lighter card
  surfaceSunken:    "bg-neutral-300",
  // neutral-400 borders are visibly darker than the neutral-300 screen
  border:           "border-neutral-400",
  divider:          "border-neutral-400",
  borderInput:      "border-neutral-500",
  textPrimary:      "text-neutral-900",
  textSecondary:    "text-neutral-600",
  // neutral-500 keeps adequate contrast on neutral-200 card backgrounds
  textTertiary:     "text-neutral-500",
  primaryBg:        "bg-neutral-800",
  primaryBgDisabled:"bg-neutral-500",
  colors: {
    tabBarBg:       "#d4d4d4",   // neutral-300 — matches screen
    tabBarBorder:   "#a3a3a3",   // neutral-400 — visible on neutral-300 bg
    tabBarActive:   "#171717",   // neutral-900 — near-black for strong contrast
    tabBarInactive: "#737373",   // neutral-500
  },
};

// ─── Exports ──────────────────────────────────────────────────────────────────

// THEMES is a map from ThemeName → Theme object.
// Used by the store to look up the full theme after rehydration.
export const THEMES: Record<ThemeName, Theme> = { light, dark, grey };

// THEME_META provides display metadata for the theme picker UI in the Profile screen.
// `swatch` represents the overall feel of each theme at a glance:
//   light → light gray  (#e5e7eb = gray-200)   — clean, airy
//   dark  → deep gray   (#1f2937 = gray-800)   — dark surface color
//   grey  → medium-dark (#737373 = neutral-500) — clearly grey, reflects the darker palette
export const THEME_META: Array<{ name: ThemeName; label: string; swatch: string }> = [
  { name: "light", label: "Light", swatch: "#e5e7eb" },
  { name: "dark",  label: "Dark",  swatch: "#1f2937" },
  { name: "grey",  label: "Grey",  swatch: "#737373" },
];
