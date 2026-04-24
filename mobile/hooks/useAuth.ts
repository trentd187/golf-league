// hooks/useAuth.ts
// Drop-in replacement for Clerk's useAuth hook.
// All screens that previously called `const { getToken } = useAuth()` from @clerk/clerk-expo
// now import from here instead — the call site is identical, no other changes needed.

import { supabase } from '@/utils/supabase';

export function useAuth() {
  // Returns the current session's JWT access token, or null if signed out.
  // Used as a Bearer token in all authenticated API requests.
  const getToken = async (): Promise<string | null> => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  };

  const signOut = () => supabase.auth.signOut();

  return { getToken, signOut };
}
