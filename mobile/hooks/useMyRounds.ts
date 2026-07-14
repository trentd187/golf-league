// hooks/useMyRounds.ts
// Fetches the signed-in user's rounds (GET /api/v1/rounds) under ONE cache key.
//
// Why this hook exists. The Rounds tab and the Stats tab both read the same endpoint, but
// under DIFFERENT query keys — ["my-rounds"] and ["rounds"] respectively. That meant two
// cache entries, two network requests for identical data, and — the real bug — a stale Stats
// tab: app/rounds/create.tsx invalidates only ["my-rounds"], so after creating or completing a
// round the Stats tab kept showing the old list until the app restarted. The comment in
// stats.tsx even claimed "React Query serves it from cache", which was simply not true.
//
// One hook, one key (MY_ROUNDS_KEY), so an invalidation anywhere reaches every consumer.
// Mirrors hooks/useMe.ts.

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { API_URL } from "@/constants/api";
import { apiGetJson } from "@/utils/apiGet";

// MY_ROUNDS_KEY is exported so mutations can invalidate the ONE key every consumer reads.
// Never hand-roll this key — that is exactly how the two caches drifted apart.
export const MY_ROUNDS_KEY = ["my-rounds"] as const;

// The endpoint returns one shape; the Rounds and Stats tabs each care about a different subset
// of its fields, so the row type is a parameter rather than being pinned here.
export function useMyRounds<T>() {
  const { getToken } = useAuth();

  return useQuery<T[]>({
    queryKey: MY_ROUNDS_KEY,
    queryFn: async () => {
      const token = await getToken();
      return apiGetJson<T[]>({
        url: `${API_URL}/api/v1/rounds`,
        token: token ?? "",
        label: "my_rounds",
      });
    },
  });
}
