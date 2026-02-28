// tailwind.config.js
// This file configures Tailwind CSS for the mobile app.
// NativeWind uses Tailwind under the hood to generate styles, so this is where
// you control which files Tailwind scans, which preset it uses, and how to extend
// or override the default design system (colors, spacing, fonts, etc.).

/** @type {import('tailwindcss').Config} */
// The JSDoc comment above tells your editor's TypeScript language server to provide
// autocomplete and type checking for the Tailwind config object. This is purely
// a developer convenience — it has no effect at runtime.
module.exports = {
  // "content" tells Tailwind which files to scan for class names.
  // Tailwind uses this list to perform "tree-shaking": it only generates CSS for
  // classes that are actually used in your source files. Any class not found here
  // will be stripped from the final build, keeping bundle size small.
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",        // All files inside the app/ directory (Expo Router screens)
    "./components/**/*.{js,jsx,ts,tsx}", // All reusable components
  ],

  // "presets" is a list of Tailwind config presets to extend from.
  // "nativewind/preset" adds React Native-specific adjustments: it maps Tailwind's
  // web-oriented utilities (like "flex", "text-", "bg-") to their React Native equivalents
  // and disables browser-only features that don't exist in React Native.
  presets: [require("nativewind/preset")],

  // "theme.extend" is where you add custom design tokens or override Tailwind defaults.
  // Currently empty, so we use Tailwind's built-in color palette, spacing scale, etc.
  theme: {
    extend: {},
  },

  // "plugins" is a list of Tailwind plugins that add extra utilities or components.
  // Empty for now — add things like @tailwindcss/forms here when needed.
  plugins: [],
};
