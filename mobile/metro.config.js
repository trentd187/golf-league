// metro.config.js
// Metro is the JavaScript bundler used by React Native and Expo.
// It bundles all your TypeScript/JS source files, images, and other assets
// into a single bundle that the app can load. This file customizes Metro's behaviour.

// getSentryExpoConfig returns Expo's base Metro config with Sentry's custom
// serializer layered in. The serializer injects a stable Debug ID into every
// bundle so the source maps EAS uploads at build time line up with the minified
// Hermes bundle that ships — no manual source-map coordination. It is a superset
// of expo/metro-config's getDefaultConfig, so we lose none of Expo's defaults.
const { getSentryExpoConfig } = require("@sentry/react-native/metro");

// withNativeWind wraps the Metro config to add NativeWind support.
// NativeWind needs to hook into Metro's pipeline so it can process your global CSS
// file and make Tailwind utility classes available in your components.
const { withNativeWind } = require("nativewind/metro");

// Start with the Sentry-enhanced Expo Metro config, passing __dirname (current
// directory) so Metro knows where the project root is.
const config = getSentryExpoConfig(__dirname);

// @supabase/supabase-js v2 ships ESM with import.meta.url (via @supabase/realtime-js).
// zustand v5 ships ESM with import.meta.env (via its devtools middleware).
// Metro skips transforming node_modules by default, so import.meta lands in the bundle
// verbatim. Expo web exports as a classic <script> (not type="module"), which causes
// "Cannot use 'import.meta' outside a module" at runtime.
//
// Fix: set transformIgnorePatterns explicitly so Metro forces these packages through
// Babel, where babel-plugin-transform-import-meta rewrites import.meta to browser-safe
// equivalents. We hardcode the full list rather than mutating the default because the
// default may be a RegExp (not a string) in some Metro versions, making .replace() a no-op.
config.transformer.transformIgnorePatterns = [
  "node_modules/(?!(@supabase|zustand|@sentry|react-native|@react-native|@react-navigation|expo|@expo|nativewind|react-native-reanimated|react-native-gesture-handler|react-native-screens|react-native-safe-area-context)/)",
];

// Wrap the config with NativeWind's Metro plugin.
// The "input" option points to the global CSS file that contains the Tailwind directives
// (@tailwind base, @tailwind components, @tailwind utilities).
// NativeWind reads this file during the build to know which Tailwind classes are available.
module.exports = withNativeWind(config, { input: "./global.css" });
