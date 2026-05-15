// utils/supabase.ts
// Supabase client singleton — import this wherever you need to call Supabase Auth or Storage.
//
// Session persistence:
//   - Native (iOS/Android): AsyncStorage so the Supabase client can await reads and writes.
//     The expo-sqlite localStorage polyfill is NOT used: its synchronous surface hides async
//     SQLite I/O, which means the PKCE code verifier write may not flush before
//     openAuthSessionAsync backgrounds the app — causing "both auth code and code verifier
//     should be non-empty" on return.
//   - Web: undefined (Supabase defaults to window.localStorage, which is synchronous and
//     always available).
//
// react-native-url-polyfill is required because @supabase/supabase-js uses the URL API
// internally and React Native's JS environment doesn't include it natively. It is a no-op
// on web where the URL API is built in.

// Must be the very first import so the URL polyfill is applied before any Supabase code runs.
import 'react-native-url-polyfill/auto';
import { Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  CryptoDigestAlgorithm,
  CryptoEncoding,
  digestStringAsync,
  getRandomValues as expoGetRandomValues,
} from 'expo-crypto';

// Hermes/JSC (React Native's JS engines) do not expose a full WebCrypto API.
// Supabase's PKCE implementation uses two surfaces:
//   1. crypto.getRandomValues — to generate the code verifier
//   2. crypto.subtle.digest   — to SHA-256 hash the verifier (S256 challenge)
// Without both, Supabase warns and falls back to `plain` PKCE. Adding `subtle.digest`
// alone (as we did first) caused Supabase to attempt S256, which then called
// `getRandomValues` and threw "crypto.getRandomValues is not a function".
// Both must be polyfilled together.

// Exported with _ prefix for unit testing — not part of the public API.
export async function _subtleDigest(
  _algorithm: string,
  data: ArrayBuffer | Uint8Array,
): Promise<ArrayBuffer> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const input = new TextDecoder().decode(bytes);
  const hashBase64 = await digestStringAsync(CryptoDigestAlgorithm.SHA256, input, {
    encoding: CryptoEncoding.BASE64,
  });
  const result = Uint8Array.from(atob(hashBase64), (c) => c.charCodeAt(0));
  return result.buffer;
}

if (!globalThis.crypto) {
  // @ts-expect-error: assigning to read-only global in RN
  globalThis.crypto = {};
}
if (!globalThis.crypto.getRandomValues) {
  // @ts-expect-error: polyfilling missing getRandomValues
  globalThis.crypto.getRandomValues = expoGetRandomValues;
}
if (!globalThis.crypto.subtle) {
  // @ts-expect-error: polyfilling non-standard partial SubtleCrypto
  globalThis.crypto.subtle = { digest: _subtleDigest };
}

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  {
    auth: {
      // Native: AsyncStorage (async — PKCE code verifier is flushed before OAuth browser opens).
      // Web: undefined — Supabase defaults to window.localStorage, which is always present.
      storage: Platform.OS === 'web' ? undefined : AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      // Native: false — the custom URL scheme (golfstuffinhere://) is not a browser URL;
      //   we extract the code manually and call exchangeCodeForSession() ourselves.
      // Web: true — Supabase automatically detects the ?code= param on the callback page
      //   and completes the PKCE exchange, then fires onAuthStateChange(SIGNED_IN).
      detectSessionInUrl: Platform.OS === 'web',
      // Explicitly use PKCE so signInWithOAuth generates response_type=code.
      // Without this, Supabase JS may default to implicit flow (response_type=token),
      // which puts tokens in the URL fragment instead of a code — causing exchangeCodeForSession
      // to fail with "both auth code and code verifier should be non-empty".
      flowType: 'pkce',
    },
  }
);
