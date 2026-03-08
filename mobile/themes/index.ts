// themes/index.ts
// Defines the 3 UI themes available in the app: Light, Dark, and Grey.
//
// Architecture — why all class strings must live here as literals:
//   Tailwind's JIT compiler scans source files at build time to discover which
//   utility classes are used, then generates only those styles. Any class string
//   constructed dynamically (e.g. `bg-${color}-700`) will NOT be generated.
//
//   By defining every theme class string as a literal in this file (which is
//   included in tailwind.config.js `content` paths), all theme classes are
//   captured at build time. At runtime, components simply select which
//   pre-scanned string to use.

// ─── Types ────────────────────────────────────────────────────────────────────

// ThemeName is the union of valid theme identifier strings — used as the
// persisted key in SecureStore and as the THEMES map key.
export type ThemeName = "light" | "dark" | "grey";

// Theme defines the shape of a single theme object. Every UI surface in the
// app maps to one of these slots.
export interface Theme {
  // Full-page background — wraps the whole ScrollView
  screen: string;
  // Card / modal / bottom-sheet background — lighter than screen so cards appear elevated
  surface: string;
  // TextInput background — matches screen so inputs look sunken relative to the card
  surfaceSunken: string;

  // Card and container borders
  border: string;
  // Subtle border-b divider between list rows
  divider: string;
  // TextInput border (may be overridden to red on validation error)
  borderInput: string;

  textPrimary: string;   // headings and primary content
  textSecondary: string; // body / supporting text
  textTertiary: string;  // muted hints, section labels, placeholders

  primaryBg: string;         // primary action button
  primaryBgDisabled: string; // primary button while loading / pending

  // Hex color values — required for React Navigation props (tabBarActiveTintColor etc.)
  // and Ionicons' `color` prop, which both require hex strings, not class names.
  colors: {
    tabBarBg: string;
    tabBarBorder: string;
    tabBarActive: string;   // active tab icon; also used for primary icon tint throughout the app
    tabBarInactive: string; // inactive tab icon; also used as placeholderTextColor
  };
}

// ─── Theme definitions ────────────────────────────────────────────────────────
// IMPORTANT: All strings must remain literals — no template literals or concatenation.

// Light — white cards, gray-50 background, green-700 brand
const light: Theme = {
  screen:            "bg-gray-50",
  surface:           "bg-white",
  surfaceSunken:     "bg-gray-50",
  border:            "border-gray-100",
  divider:           "border-gray-100",
  borderInput:       "border-gray-300",
  textPrimary:       "text-gray-900",
  textSecondary:     "text-gray-600",
  textTertiary:      "text-gray-400",
  primaryBg:         "bg-green-700",
  primaryBgDisabled: "bg-green-400",
  colors: {
    tabBarBg:       "#ffffff",
    tabBarBorder:   "#e5e7eb",
    tabBarActive:   "#15803d",
    tabBarInactive: "#9ca3af",
  },
};

// Dark — deep gray background, elevated cards, green-600 brand
const dark: Theme = {
  screen:            "bg-gray-900",
  surface:           "bg-gray-800",
  surfaceSunken:     "bg-gray-900",
  border:            "border-gray-700",
  divider:           "border-gray-700",
  borderInput:       "border-gray-600",
  textPrimary:       "text-gray-100",
  textSecondary:     "text-gray-300",
  textTertiary:      "text-gray-500",
  primaryBg:         "bg-green-600",
  primaryBgDisabled: "bg-green-800",
  colors: {
    tabBarBg:       "#111827",
    tabBarBorder:   "#374151",
    tabBarActive:   "#16a34a",
    tabBarInactive: "#6b7280",
  },
};

// Grey — neutral palette.
//   screen = neutral-300, surface = neutral-200 (lighter = elevated),
//   surfaceSunken = neutral-300 (matches screen → appears inset on neutral-200 cards).
const grey: Theme = {
  screen:            "bg-neutral-300",
  surface:           "bg-neutral-200",
  surfaceSunken:     "bg-neutral-300",
  border:            "border-neutral-400",
  divider:           "border-neutral-400",
  borderInput:       "border-neutral-500",
  textPrimary:       "text-neutral-900",
  textSecondary:     "text-neutral-600",
  textTertiary:      "text-neutral-500",
  primaryBg:         "bg-neutral-800",
  primaryBgDisabled: "bg-neutral-500",
  colors: {
    tabBarBg:       "#d4d4d4", // neutral-300 — matches screen
    tabBarBorder:   "#a3a3a3", // neutral-400
    tabBarActive:   "#171717", // neutral-900 — near-black for strong contrast
    tabBarInactive: "#737373", // neutral-500
  },
};

// ─── Exports ──────────────────────────────────────────────────────────────────

// THEMES maps ThemeName → Theme. Used by the store to look up the full theme
// after rehydrating the persisted themeName from SecureStore.
export const THEMES: Record<ThemeName, Theme> = { light, dark, grey };

// THEME_META provides display metadata for the theme picker UI in the Profile screen.
// `swatch` is a representative hex that conveys the feel of each theme at a glance.
export const THEME_META: Array<{ name: ThemeName; label: string; swatch: string }> = [
  { name: "light", label: "Light", swatch: "#e5e7eb" }, // gray-200 — clean, airy
  { name: "dark",  label: "Dark",  swatch: "#1f2937" }, // gray-800 — dark surface
  { name: "grey",  label: "Grey",  swatch: "#737373" }, // neutral-500 — clearly grey
];
