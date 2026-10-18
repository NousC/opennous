// "Follow-up ready" on the account: the follow-up engine's cards for this account that still wait
// on a decision, shown as the same card Home shows (approve, skip, which deal), so a rep who lands
// here from anywhere can decide it in place.
//
// Read from GET /api/follow-ups?accountId=, the whole team's cards for this account: the page is
// about the account, so the card is shown whoever it is for. A decision is written back into the
// query's cache, so leaving and coming back shows the receipt rather than the card again; the
// next refetch drops it, since only waiting cards are asked for.
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { FollowUpCard, followUpApi, isReady, rowToRecommendation } from "@/components/home/FollowUps";
import type { FollowUp, FollowUpRow, Recommendation } from "@/components/home/types";
import { SectionHead } from "@/components/account/parts";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

const followUpsKey = (wsId: string, companyId: string | null | undefined) => ["follow-ups", wsId, companyId ?? null] as const;

/** This account's waiting follow-ups, as Home's recommendations. `_personIds` is kept for the
 *  callers: the engine files every card on the account, so people are not needed to find them. */
export function useAccountFollowUps(companyId: string | null | undefined, _personIds?: string[], enabled = true): Recommendation[] {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const wsId = (userData as { workspace?: { id?: string } } | null)?.workspace?.id ?? "";
  // Keyed without the token: it rotates and must not refetch.
  const q = useQuery<Recommendation[]>({
    queryKey: followUpsKey(wsId, companyId),
    enabled: enabled && !!token && !!wsId && !!companyId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/follow-ups?workspaceId=${wsId}&accountId=${encodeURIComponent(companyId ?? "")}&status=ready&scope=team`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`follow-ups ${r.status}`);
      const d = await r.json();
      return (Array.isArray(d?.follow_ups) ? d.follow_ups as FollowUpRow[] : []).map(rowToRecommendation);
    },
  });
  return q.data ?? [];
}

/** Nothing renders when there is nothing waiting: an empty "Follow-up ready" is noise. */
export function FollowUpReady({ recs }: { recs: Recommendation[] }) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const wsId = (userData as { workspace?: { id?: string } } | null)?.workspace?.id ?? "";
  const qc = useQueryClient();
  const navigate = useNavigate();
  const actions = useMemo(() => followUpApi(apiUrl, token, wsId), [token, wsId]);
  // The cards were read by account, so a card's account is the key it was cached under.
  const onChange = useCallback((r: Recommendation, fu: FollowUp) => {
    qc.setQueryData<Recommendation[]>(followUpsKey(wsId, r.account.id), (old) =>
      old?.map((x) => (x.id === r.id ? { ...x, followup: fu } : x)));
  }, [qc, wsId]);

  if (!recs.length) return null;
  const waiting = recs.filter(isReady).length;
  return (
    <div className="min-w-0">
      <SectionHead title="Follow-up ready" meta={waiting > 1 ? String(waiting) : undefined} />
      <div className="space-y-3">
        {recs.map((r) => (
          // Folded, as in the design: the row already says what is waiting, and the account's
          // overview below it stays in reach.
          <FollowUpCard key={r.id} r={r} tasks={null} dealChange={null}
            actions={actions} onChange={onChange}
            onTask={(t) => navigate(`/tasks/${encodeURIComponent(t.id)}`)} />
        ))}
      </div>
    </div>
  );
}
