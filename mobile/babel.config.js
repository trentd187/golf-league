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
    plugins: [
      // @supabase/realtime-js ships ESM code that includes import.meta.url.
      // metro.config.js forces @supabase packages through Babel; this plugin then
      // rewrites import.meta.url to a browser-safe equivalent so the bundle works
      // when served as a classic <script> (Expo web export does not use type="module").
      // NOTE: this plugin only handles import.meta.url — NOT import.meta.env.
      "babel-plugin-transform-import-meta",

      // zustand v5 devtools middleware ships ESM with import.meta.env.MODE to check
      // whether Redux DevTools should activate. babel-plugin-transform-import-meta
      // only handles import.meta.url, so import.meta.env passes through untransformed.
      //
      // This inline plugin replaces every `import.meta.env` expression with
      // `process.env`. Metro/webpack polyfills `process.env` for the browser, so
      // `process.env.MODE` evaluates to `undefined` (no MODE env var → devtools
      // integration is silently disabled, which is fine for web production).
      function importMetaEnvPlugin({ types: t }) {
        return {
          visitor: {
            // Match: import.meta.env (MemberExpression where object is the
            // MetaProperty `import.meta` and property is the identifier `env`).
            MemberExpression(path) {
              const { object, property } = path.node;
              if (
                t.isMetaProperty(object) &&
                object.meta.name === "import" &&
                object.property.name === "meta" &&
                t.isIdentifier(property) &&
                property.name === "env"
              ) {
                path.replaceWith(
                  t.memberExpression(
                    t.identifier("process"),
                    t.identifier("env")
                  )
                );
              }
            },
          },
        };
      },
    ],
  };
};
