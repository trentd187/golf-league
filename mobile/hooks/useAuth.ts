// hooks/useAuth.ts
// Supabase Auth hook — exposes getToken and signOut for use across all screens.
// Screens call `const { getToken } = useAuth()` to obtain a Bearer token for API requests.

import { supabase } from '@/utils/supabase';
import { reportAuthFailure } from '@/utils/sentry';

export function useAuth() {
  // Returns the current session's JWT access token, or null if signed out.
  // Used as a Bearer token in all authenticated API requests.
  //
  // This runs in front of EVERY read and write in the app, so its failure modes matter more
  // than its size suggests:
  //
  //   - getSession() is not purely local. Once the access token expires it refreshes over the
  //     network. That call is bounded and retried by utils/supabaseFetch.ts — before that it
  //     was an unbounded bare fetch sitting in front of the entire hardened layer.
  //   - Both failure shapes are now reported. Callers do `(await getToken()) ?? ""`, which
  //     sends `Authorization: Bearer ` and earns a 401 — and a 401 reads as ordinary 4xx
  //     noise, so a fleet-wide session expiry looked like nothing at all. An auth_stage signal
  //     tells the two apart.
  const getToken = async (): Promise<string | null> => {
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        // Expected shape: an expired or revoked refresh token. Log, don't alarm.
        reportAuthFailure(error, { stage: 'get_token' });
        return null;
      }
      return data.session?.access_token ?? null;
    } catch (err) {
      // A THROWN getSession is exceptional (broken storage, or the refresh exhausting its
      // retries). Every call made after this point will 401, so it warrants an Issue.
      reportAuthFailure(err, { stage: 'get_token', fatal: true });
      return null;
    }
  };

  const signOut = () => supabase.auth.signOut();

  return { getToken, signOut };
}
