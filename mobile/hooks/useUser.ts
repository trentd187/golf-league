// hooks/useUser.ts
// Returns the current Supabase user object and a loading flag.
// The user object comes from supabase.auth and updates reactively via onAuthStateChange.

import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '@/utils/supabase';
import { syncSentryUser } from '@/utils/sentry';

export function useUser() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Read the locally-stored session on mount. getSession() is local (no network),
    // unlike getUser() which makes a round-trip to Supabase's /auth/v1/user to
    // revalidate the token on every mount — and useUser() is mounted by many screens
    // (profile, friends, event, round, scorecard), so getUser() was a frequent ~1s
    // call. The session's user is sufficient for UI attribution; the backend still
    // validates every JWT via JWKS on each API call, so we don't need client-side
    // server revalidation here. autoRefreshToken keeps the cached session fresh.
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      // Attach the user to Sentry so events/replays are attributed to them.
      syncSentryUser(data.session?.user ?? null);
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
