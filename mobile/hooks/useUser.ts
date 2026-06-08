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
    // Load the current session immediately on mount.
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      // Attach the user to Sentry so events/replays are attributed to them.
      syncSentryUser(data.user);
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
