// hooks/useMe.ts
// Fetches the current user's profile from our backend (GET /api/v1/me).
// Role lives only in our PostgreSQL users.role column — it is not embedded in
// the Supabase JWT — so this is the authoritative source for role-gated UI.
//
// TanStack Query caches the result under the ["me"] key, so multiple components
// calling useMe() in the same render share a single network request.

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useUser } from "@/hooks/useUser";
import { API_URL } from "@/constants/api";
import { apiFetch } from "@/utils/api";

export type MeResponse = {
  id: string;
  display_name: string;
  email: string;
  avatar_url?: string;
  role: string;
};

export function useMe() {
  const { getToken } = useAuth();
  const { user } = useUser();

  return useQuery<MeResponse>({
    queryKey: ["me"],
    queryFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to fetch profile");
      return res.json();
    },
    // Only run when a Supabase session exists.
    enabled: !!user,
  });
}
