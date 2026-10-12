import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { AuthContext } from "@/contexts/AuthContext";
import { CRM_COLOR, crmLabel, isCrmProvider, rememberCrm, type CrmProvider } from "@/lib/crm";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

/**
 * Which CRM this workspace is connected to (GET-602), from the onboarding checklist's
 * `crm.provider`. Cached for half an hour: the answer changes once in a workspace's life.
 */
export function useCrm(): { provider: CrmProvider | null; label: string; color: string; connected: boolean } {
  // The context directly (not useAuth), so a component naming the CRM never throws outside the
  // app shell — the dev gallery, a preview harness.
  const auth = useContext(AuthContext);
  const userData = auth?.userData;
  const session = auth?.session;
  const ws = (userData as { workspace?: { id?: string } } | null)?.workspace?.id ?? "";
  const q = useQuery({
    queryKey: ["crm-provider", ws],
    enabled: !!ws,
    staleTime: 30 * 60_000,
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/onboarding/checklist?workspaceId=${encodeURIComponent(ws)}`, {
        headers: { Authorization: `Bearer ${session?.access_token ?? ""}` },
      });
      if (!r.ok) return { provider: null as string | null, done: false };
      const d = await r.json();
      return { provider: (d?.crm?.provider ?? null) as string | null, done: !!d?.crm?.done };
    },
  });
  const provider = isCrmProvider(q.data?.provider) ? q.data!.provider as CrmProvider : null;
  const label = crmLabel(provider);
  rememberCrm(label);
  return { provider, label, color: provider ? CRM_COLOR[provider] : "hsl(var(--muted-foreground))", connected: !!q.data?.done };
}
