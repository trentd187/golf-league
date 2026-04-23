// utils/supabase.ts
// Supabase client singleton — import this wherever you need to call Supabase Auth or Storage.
//
// Session persistence uses expo-sqlite's localStorage polyfill (the official Supabase/Expo pattern).
// react-native-url-polyfill is required because @supabase/supabase-js uses the URL API internally
// and React Native's JS environment doesn't include it natively.

// Must be the very first import so the URL polyfill is applied before any Supabase code runs.
import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
// Installs a global localStorage backed by expo-sqlite so Supabase can persist sessions.
import 'expo-sqlite/localStorage/install';

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  {
    auth: {
      // localStorage is provided by the expo-sqlite polyfill installed above.
      storage: localStorage,
      autoRefreshToken: true,
      persistSession: true,
      // Must be false in React Native — the URL scheme is not a browser URL.
      detectSessionInUrl: false,
    },
  }
);
