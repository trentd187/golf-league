// metro.config.js
// Metro is the JavaScript bundler used by React Native and Expo.
// It bundles all your TypeScript/JS source files, images, and other assets
// into a single bundle that the app can load. This file customizes Metro's behaviour.

// getDefaultConfig returns the base Metro configuration that Expo provides.
// We extend it rather than writing from scratch so we inherit all Expo's defaults.
const { getDefaultConfig } = require("expo/metro-config");

// withNativeWind wraps the Metro config to add NativeWind support.
// NativeWind needs to hook into Metro's pipeline so it can process your global CSS
// file and make Tailwind utility classes available in your components.
const { withNativeWind } = require("nativewind/metro");

// Start with the default Expo Metro config, passing __dirname (current directory)
// so Metro knows where the project root is.
const config = getDefaultConfig(__dirname);

// Wrap the config with NativeWind's Metro plugin.
// The "input" option points to the global CSS file that contains the Tailwind directives
// (@tailwind base, @tailwind components, @tailwind utilities).
// NativeWind reads this file during the build to know which Tailwind classes are available.
module.exports = withNativeWind(config, { input: "./global.css" });
