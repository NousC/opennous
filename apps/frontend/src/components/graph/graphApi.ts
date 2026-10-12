// Reads for the Relationships tab: /api/graph (the network) and /api/graph/claims (what we learned).
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { freshAccessToken } from "@/lib/freshToken";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

export function useGraphApi<T>(key: string, path: string | null) {
  const { session, userData } = useAuth();
  const workspaceId = (userData as { workspace?: { id?: string } })?.workspace?.id ?? "";
  return useQuery({
    queryKey: ["graph", workspaceId, key] as const,
    enabled: Boolean(session?.access_token && workspaceId && path),
    staleTime: 60_000,
    queryFn: async (): Promise<T> => {
      const token = (await freshAccessToken()) ?? session?.access_token;
      const sep = path!.includes("?") ? "&" : "?";
      const r = await fetch(`${apiUrl}${path}${sep}workspaceId=${encodeURIComponent(workspaceId)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`graph_${r.status}`);
      return r.json();
    },
  });
}
