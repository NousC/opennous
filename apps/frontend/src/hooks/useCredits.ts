// The credits meter for the API-plan sidebar (GET-620). Reads /api/billing/state, the payload the
// Usage page reads, and shapes it with creditsMeter. Null while loading, on error, or when the
// workspace has no live allowance: the card simply doesn't render.

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { creditsMeter, type CreditsMeter, type CreditsState } from "@/lib/credits";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

export function useCredits(enabled = true): CreditsMeter | null {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const { data } = useQuery<CreditsState>({
    queryKey: ["billing-state", workspaceId],
    queryFn: async () => {
      const qs = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : "";
      const r = await fetch(`${apiUrl}/api/billing/state${qs}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return null;
      return r.json();
    },
    enabled: enabled && !!token,
    staleTime: 60_000,
  });
  return creditsMeter(data);
}
