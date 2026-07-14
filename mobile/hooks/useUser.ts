// hooks/useUser.ts
// Returns the current Supabase user object and a loading flag.
// The user object comes from supabase.auth and updates reactively via onAuthStateChange.

import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '@/utils/supabase';
import { reportAuthFailure, syncSentryUser } from '@/utils/sentry';

export function useUser() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Read the stored session on mount, rather than getUser() — which round-trips to
    // Supabase's /auth/v1/user to revalidate on EVERY mount, and useUser() is mounted by many
    // screens (profile, friends, event, round, scorecard), so it was a frequent ~1s call. The
    // session's user is enough for UI attribution; the backend still validates every JWT via
    // JWKS on each API call.
    //
    // getSession() is usually local, but it is NOT guaranteed to be: when the access token has
    // expired it refreshes over the network. That call is bounded by utils/supabaseFetch.ts.
    supabase.auth
      .getSession()
      .then(({ data }) => {
        setUser(data.session?.user ?? null);
        // Attach the user to Sentry so events/replays are attributed to them.
        syncSentryUser(data.session?.user ?? null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        // Without this catch a rejection pinned `loading` true forever — and every consumer
        // gates on it (profile.tsx renders null while userLoading), so a screen went
        // permanently blank with no signal. Treat it as signed-out and let the UI proceed.
        reportAuthFailure(err, { stage: "use_user_session_restore", fatal: true });
        setUser(null);
        syncSentryUser(null);
        setLoading(false);
      });

    // Keep user state in sync with auth events (sign-in, sign-out, token refresh).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      // Update (or clear, on sign-out) the Sentry user context to match.
      syncSentryUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  return { user, loading };
}
