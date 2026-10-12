// The drafts waiting on you (GET-681), for the Priorities inbox's "To approve": GET /api/actions,
// pending only, the caller's own, each with the automation that wrote it (`origin`) and the
// account it is for. One query, shared by the ⚑ count and the panel.
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { freshAccessToken } from "@/lib/freshToken";
import type { InboxAction } from "./inboxModel";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

export const draftsKey = (ws: string) => ["pending-actions", ws] as const;

export function usePendingDrafts(ws: string, fallbackToken: string | undefined) {
  return useQuery({
    queryKey: draftsKey(ws),
    enabled: !!ws,
    staleTime: 60_000,
    queryFn: async (): Promise<InboxAction[]> => {
      const token = (await freshAccessToken()) ?? fallbackToken ?? "";
      const r = await fetch(`${apiUrl}/api/actions?workspaceId=${ws}&status=pending&scope=mine&include=origin`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error("actions");
      const b = await r.json();
      return Array.isArray(b.actions) ? b.actions : [];
    },
  });
}

/** A draft decided in the panel: its row stays with the result, and the counts leave it out. */
export function markDraftDecided(queryClient: QueryClient, ws: string, id: string, status: "sent" | "rejected") {
  queryClient.setQueryData<InboxAction[]>(draftsKey(ws), (old) => old?.map((a) => (a.id === id ? { ...a, status } : a)));
}
