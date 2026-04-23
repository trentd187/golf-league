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
