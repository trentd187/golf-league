// hooks/useAuth.ts
// Supabase Auth hook — exposes getToken and signOut for use across all screens.
// Screens call `const { getToken } = useAuth()` to obtain a Bearer token for API requests.

import { supabase } from '@/utils/supabase';
import { getFreshAccessToken } from '@/utils/freshToken';

export function useAuth() {
  // getToken returns the current session's JWT access token (refreshing over the network
  // when it has expired), or null if signed out. Used as a Bearer token in all authenticated
  // API requests. The implementation lives in utils/freshToken.ts so non-React code — notably
  // the save-retry core (utils/saveWithRetry.ts), which must re-resolve the token between
  // retries — can obtain a token too. See freshToken.ts for the failure-mode rationale.
  const getToken = getFreshAccessToken;

  const signOut = () => supabase.auth.signOut();

  return { getToken, signOut };
}
