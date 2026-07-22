// utils/freshToken.ts
// getFreshAccessToken — resolve the current Supabase access token, refreshing over the
// network when the cached one has expired. This is the same logic that backs
// useAuth().getToken (which now delegates here), extracted as a plain async function so
// non-React code can obtain a token too.
//
// Why this exists as its own module: the network save core (utils/saveWithRetry.ts) needs
// to re-resolve the token *between retries*, not just once at the call site. A save that is
// backgrounded mid-round can sit in its backoff loop for minutes (Android suspends the JS
// timers, so elapsed wall-clock far exceeds the nominal budget); the token captured when the
// save started expires, and every remaining attempt then 401s with a stale bearer. saveWithRetry
// calls this after a 401 to mint a live token for the next attempt. It runs in front of a
// network call, so its failure modes matter — both are reported (see useAuth.ts for the full
// rationale on the fatal/non-fatal split).

import { supabase } from "@/utils/supabase";
import { reportAuthFailure } from "@/utils/sentry";

// getFreshAccessToken returns the session's JWT access token, or null when signed out or
// when the session can't be restored. getSession() is not purely local: once the access
// token expires it refreshes over the network (that call is bounded + retried by
// utils/supabaseFetch.ts's global fetch wrapper).
export async function getFreshAccessToken(): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      // Expected shape: an expired or revoked refresh token. Log, don't alarm.
      reportAuthFailure(error, { stage: "get_token" });
      return null;
    }
    return data.session?.access_token ?? null;
  } catch (err) {
    // A THROWN getSession is exceptional (broken storage, or the refresh exhausting its
    // retries). Callers fall back to the stale token, so it warrants an Issue.
    reportAuthFailure(err, { stage: "get_token", fatal: true });
    return null;
  }
}
