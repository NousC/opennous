// The account health trend (GET-804): weekly points backfilled over 60 days plus the stored daily
// snapshots, one point a day, from GET /api/companies/:id/account-health-trend. The card appends
// today's score itself, so today's point is dropped here and the line ends on the number the card
// shows.
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import type { HealthPoint } from "@/components/record/RecordParts";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

type TrendPoint = { at: string; score: number; label?: string | null; source?: string };

const dayKey = (iso: string) => new Date(iso).toISOString().slice(0, 10);

export function useAccountHealthTrend(companyId: string | null) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const wsId = (userData as { workspace?: { id?: string } } | null)?.workspace?.id ?? "";
  return useQuery({
    queryKey: ["account-health-trend", wsId, companyId],
    enabled: !!token && !!wsId && !!companyId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<HealthPoint[]> => {
      const r = await fetch(`${apiUrl}/api/companies/${companyId}/account-health-trend?workspaceId=${wsId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return [];
      const body = (await r.json()) as { series?: TrendPoint[] };
      const today = dayKey(new Date().toISOString());
      return (body.series ?? []).filter(p => dayKey(p.at) < today).map(p => ({ at: p.at, score: p.score }));
    },
  });
}
