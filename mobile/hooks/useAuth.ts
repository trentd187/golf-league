// hooks/useAuth.ts
// Supabase Auth hook — exposes getToken and signOut for use across all screens.
// Screens call `const { getToken } = useAuth()` to obtain a Bearer token for API requests.

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
