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
| `expo-image-manipulator` | `~14.0.8` | Native (iOS/Android) avatar downscale-to-≤512px JPEG before upload (`utils/avatar.ts` → `resizeNativeImageToJpegUri`), mirroring the web canvas path; installed via `npx expo install`. Native module → needs an EAS rebuild to ship (bundled in Expo Go SDK 54). No config plugin |
| `@react-native-community/datetimepicker` | `8.4.4` | Native date picker used by `components/DateInput.tsx`; installed via `npx expo install @react-native-community/datetimepicker` |
| `@expo/vector-icons` | `~15.1.1` | Transitive dep of expo; pnpm strict mode means TypeScript can't find its types unless it's a direct dep — causes `Cannot find module '@expo/vector-icons/Ionicons'` in CI |
| `expo-font` | `~14.0.11` | Required peer dep of `@expo/vector-icons`; missing causes expo-doctor check failure and potential runtime crash outside Expo Go |
| `@react-native-community/netinfo` | `11.4.1` | SDK-54-compatible; installed via `npx expo install`. Used by `utils/saveRequest.ts` to snapshot connection type/cellular generation when a save fails — see [network-saves.md](network-saves.md). Jest resolves it via the manual mock in `__mocks__/@react-native-community/netinfo.js` |
| `react-native-keyboard-controller` | `1.18.5` | Powers the scorecard's `KeyboardAwareScrollView` (auto-lifts the focused input, dynamic keyboard inset — no permanent bottom padding). Built on Reanimated (already installed). Requires `<KeyboardProvider>` at the app root (`app/_layout.tsx`). **Native module → NOT bundled in Expo Go**, so it needs a dev-client/preview EAS build to run *and* to test locally. Web-safe (renders a plain ScrollView). Jest resolves it via `jest.setup.js` → `require("react-native-keyboard-controller/jest")` (registered in `package.json` `jest.setupFiles`). See [keyboard-and-platform.md](keyboard-and-platform.md) |

**Important:** pnpm `overrides` do NOT work for peer dependency resolution — you must add the package as a direct `dependency` to control what version peer-dependent packages get.

After any `package.json` change, run `pnpm start --clear` to flush Metro's cache.
`npx expo install --fix` resolves correct SDK-54-compatible versions for all expo packages.

## Security advisories (Dependabot / audits)

**Mobile/npm — audit with `pnpm audit --prod`.** As of the 2026-06 review, every npm
advisory (incl. the one critical, `shell-quote`) lives in **dev/build tooling** pulled
transitively by `expo` / `@expo/cli` / `metro` / `react-native` CLI / `react-devtools-core`.
None of it is bundled into the shipped app or runs on the backend — it executes only on a
developer/CI machine. **Posture: defer to the next Expo SDK 54.x (or SDK) bump** rather than
forcing transitive overrides, which risk breaking the Expo toolchain for no runtime gain.
SDK 54 is pinned (Expo Go compatibility) so a same-major SDK bump is the clean remediation path.

The only advisory touching a *shipped* dependency is `ws` via
`@supabase/supabase-js > @supabase/realtime-js`. It is **not exploitable here**: the app never
opens a Realtime channel (no `.channel(` usage), and on RN/web Supabase uses the global
`WebSocket`, not the `ws` package. A `pnpm update @supabase/supabase-js` (in-range, `^2.x`)
clears the alert but touches the auth client — treat as opt-in, not urgent.

**Backend/Go — audit with `govulncheck ./...`** (`go install golang.org/x/vuln/cmd/govulncheck@latest`).
Unlike the mobile side, Go advisories **can be reachable server-side and must be fixed** — the
2026-06 review found called vulns in `golang.org/x/crypto` and `golang.org/x/net`, fixed by
bumping the modules (`go get <mod>@latest && go mod tidy`). Remaining `CALLED` findings are Go
**stdlib**; those are not Dependabot-scanned and clear automatically because the builder image
floats to the latest patch (`golang:1.26-alpine`) on each Railway rebuild. Dependabot does **not**
scan the Go stdlib/toolchain — only `go.mod` modules.
