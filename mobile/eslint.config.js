// eslint.config.js
// ESLint flat configuration for the Golf League mobile app (Expo SDK 54, ESLint 9).
//
// What this file configures:
//   1. eslint-config-expo  — Expo's official rule set: React, React Native, TypeScript,
//                            and import hygiene rules tailored to Expo projects.
//   2. eslint-plugin-react-native — Additional React Native-specific rules, primarily
//                            react-native/no-inline-styles, which flags inline style objects.
//                            We use inline styles intentionally in a few places (theme hex
//                            colors for Ionicons/ActivityIndicator) and mark those with
//                            eslint-disable-next-line comments.
//   3. Rule overrides       — Turns off rules that produce false positives in our stack.
//
// Run the linter:
//   pnpm lint            → check all files, report errors
//   pnpm lint --fix      → auto-fix simple issues (unused imports, formatting) where possible
//
// ESLint "flat config" (this format) was introduced in ESLint 9. Instead of .eslintrc.*
// files, config is an array exported from eslint.config.js. Each object in the array
// applies rules to matching files, and later objects override earlier ones.

// defineConfig: a typed helper that validates the config shape at authoring time.
// It doesn't change runtime behaviour — just provides IDE autocomplete.
const { defineConfig } = require('eslint/config');

// eslint-config-expo/flat exports an array of ESLint config objects for Expo projects.
// It includes React, React Native, TypeScript-eslint, and import resolver rules.
const expoConfig = require("eslint-config-expo/flat");

// eslint-plugin-react-native provides React Native-specific rules including
// react-native/no-inline-styles (warns when style={{}} is used instead of NativeWind className).
const reactNativePlugin = require("eslint-plugin-react-native");

module.exports = defineConfig([
  // ---- Base: Expo's recommended config ----
  // Applies React, React Native, TypeScript, and import rules to all .ts/.tsx files.
  expoConfig,

  // ---- React Native plugin registration ----
  // Makes the "react-native" rule namespace available for configuration below.
  {
    plugins: {
      // "react-native" is the prefix used in rule names: react-native/no-inline-styles, etc.
      "react-native": reactNativePlugin,
    },
  },

  // ---- Rule overrides ----
  // These take precedence over everything above.
  {
    rules: {
      // react-native/no-inline-styles warns when style={{...}} is used directly on a component.
      // We style with NativeWind className throughout, so inline styles only appear when a
      // dynamic hex color is needed from the theme (e.g. <Ionicons color={t.colors.tabBarActive}>).
      // Those intentional occurrences are suppressed with "// eslint-disable-next-line react-native/no-inline-styles".
      "react-native/no-inline-styles": "warn",

      // import/no-unresolved is turned off because:
      //   a) pnpm's node_modules layout (.pnpm/) confuses the default ESLint import resolver,
      //      causing false positives for packages like @expo/vector-icons that are installed.
      //   b) TypeScript's compiler (tsc --noEmit, in the pre-commit hook) already catches
      //      real missing imports with full accuracy — no value in having ESLint duplicate it.
      "import/no-unresolved": "off",
    },
  },

  // ---- Ignored paths ----
  {
    ignores: [
      "dist/**",         // Expo production build output
      ".expo/**",        // Expo CLI cache and generated files
      "node_modules/**",
    ],
  },
]);
