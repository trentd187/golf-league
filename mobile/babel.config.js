// babel.config.js
// Babel is a JavaScript/TypeScript compiler (transpiler) that transforms modern code
// into a format that can run on older devices and the React Native JavaScript engine.
// This file tells Babel which presets and plugins to use when compiling the project.

module.exports = function (api) {
  // api.cache(true) tells Babel to cache the result of this config function.
  // Without caching, Babel would re-evaluate this file on every compile, which is slow.
  // Set to false only if your config needs to change based on dynamic values at build time.
  api.cache(true);

  return {
    presets: [
      // "babel-preset-expo" is the standard Expo/React Native Babel preset.
      // It handles JSX, TypeScript, modern JavaScript features, and React Native specifics.
      // The jsxImportSource option tells Babel to use NativeWind's JSX transform instead
      // of the default React one. This is what makes the "className" prop work on
      // React Native components — NativeWind intercepts it and applies Tailwind styles.
      ["babel-preset-expo", { jsxImportSource: "nativewind" }],

      // "nativewind/babel" is NativeWind's own Babel preset.
      // It processes the className strings at compile time, converting Tailwind class names
      // into the inline StyleSheet objects that React Native actually understands.
      "nativewind/babel",
    ],
  };
};
