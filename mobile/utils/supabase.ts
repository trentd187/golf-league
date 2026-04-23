// utils/supabase.ts
// Supabase client singleton — import this wherever you need to call Supabase Auth or Storage.
//
// Session persistence uses AsyncStorage so the Supabase client can await reads and writes.
// The expo-sqlite localStorage polyfill is NOT used here: its synchronous surface hides async
// SQLite I/O, which means the PKCE code verifier write may not flush before openAuthSessionAsync
// backgrounds the app — causing "both auth code and code verifier should be non-empty" on return.
//
// react-native-url-polyfill is required because @supabase/supabase-js uses the URL API internally
// and React Native's JS environment doesn't include it natively.

// Must be the very first import so the URL polyfill is applied before any Supabase code runs.
import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CryptoDigestAlgorithm, CryptoEncoding, digestStringAsync } from 'expo-crypto';

// React Native's JS engine does not expose `globalThis.crypto.subtle`, so Supabase's PKCE
// implementation cannot use SHA-256 and warns that it will fall back to the `plain` challenge
// method. Polyfill only `subtle.digest` — the one surface Supabase actually uses — via
// expo-crypto. The PKCE code verifier is always a base64url ASCII string, so passing it
// through TextDecoder before hashing is safe (UTF-8 of ASCII bytes == the ASCII bytes).

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
if (!globalThis.crypto.subtle) {
  // @ts-expect-error: polyfilling non-standard partial SubtleCrypto
  globalThis.crypto.subtle = { digest: _subtleDigest };
}

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  {
    auth: {
      // AsyncStorage is async — Supabase awaits each read/write, so the PKCE code verifier
      // is guaranteed to be persisted before the OAuth browser session opens.
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      // Must be false in React Native — the URL scheme is not a browser URL.
      detectSessionInUrl: false,
      // Explicitly use PKCE so signInWithOAuth generates response_type=code.
      // Without this, Supabase JS may default to implicit flow (response_type=token),
      // which puts tokens in the URL fragment instead of a code — causing exchangeCodeForSession
      // to fail with "both auth code and code verifier should be non-empty".
      flowType: 'pkce',
    },
  }
);
