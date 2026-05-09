# SDK 54 Dependency Quirks

pnpm's strict resolution requires the following packages to be **direct dependencies** (not just transitive). Without them, either the bundler fails or the wrong version is loaded at runtime.

| Package | Version | Why direct dep is needed |
|---|---|---|
| `@expo/metro-runtime` | `~6.1.2` | expo-router 6.0.23 imports it directly; without it: `Unable to resolve "@expo/metro-runtime/error-overlay"` |
| `react-native-css-interop` | `latest` | NativeWind peer dep not auto-hoisted |
| `expo-web-browser` | `~15.0.10` | Used for Supabase Google OAuth web flow (`WebBrowser.openAuthSessionAsync`) |
| `expo-auth-session` | `~7.0.10` | Provides `makeRedirectUri()` for Supabase OAuth redirect URL; without it pnpm may resolve to SDK 55 version causing `Cannot find native module 'ExpoCryptoAES'` |
| `expo-sqlite` | `~16.0.10` | Plugin registered in `app.config.js`; the `localStorage` polyfill (`expo-sqlite/localStorage/install`) is no longer used for Supabase auth — see below |
| `@react-native-async-storage/async-storage` | `2.2.0` | Supabase auth session + PKCE code verifier storage. The expo-sqlite localStorage polyfill was replaced because its sync surface hides async SQLite I/O — the PKCE verifier write wasn't flushing before `openAuthSessionAsync` backgrounded the app, causing "both auth code and code verifier should be non-empty" on OAuth return |
| `react-native-url-polyfill` | `3.x` | Required by `@supabase/supabase-js` — React Native's JS env doesn't include the URL API natively |
| `@supabase/supabase-js` | `2.x` | Supabase Auth + Storage client; includes storage functionality (no separate `@supabase/storage-js` needed) |
| `expo-crypto` | `~15.0.8` | SDK 54 compatible version; 55.x is SDK 55 only |
| `expo-image-picker` | `~17.0.10` | Profile photo upload; installed via `npx expo install expo-image-picker` |
| `@react-native-community/datetimepicker` | `8.4.4` | Native date picker used by `components/DateInput.tsx`; installed via `npx expo install @react-native-community/datetimepicker` |
| `@expo/vector-icons` | `~15.1.1` | Transitive dep of expo; pnpm strict mode means TypeScript can't find its types unless it's a direct dep — causes `Cannot find module '@expo/vector-icons/Ionicons'` in CI |
| `expo-font` | `~14.0.11` | Required peer dep of `@expo/vector-icons`; missing causes expo-doctor check failure and potential runtime crash outside Expo Go |

**Important:** pnpm `overrides` do NOT work for peer dependency resolution — you must add the package as a direct `dependency` to control what version peer-dependent packages get.

After any `package.json` change, run `pnpm start --clear` to flush Metro's cache.
`npx expo install --fix` resolves correct SDK-54-compatible versions for all expo packages.
