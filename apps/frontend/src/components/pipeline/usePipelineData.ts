// The reads the Pipeline page (and the command palette's deal search) make. Each is a react-query
// hook so two surfaces asking for the same deals share one request instead of racing two.

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import type { DealScope, DealsPayload, PipelineOption, WsStage } from "./dealModel";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

export function useWorkspaceAuth() {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = (userData as { workspace?: { id?: string } } | null)?.workspace?.id ?? "";
  return { token, workspaceId, ready: !!token && !!workspaceId };
}

// The market the Accounts list remembers per workspace. The pipeline reads the same key so the two
// pages never show different markets for one workspace; undefined means "not chosen", and the
// server then applies the workspace's own focus.
export const countryKey = (workspaceId: string) => `nous.accounts.country.${workspaceId}`;
export function readRememberedCountry(workspaceId: string): string | undefined {
  try { return localStorage.getItem(countryKey(workspaceId)) ?? undefined; } catch { return undefined; }
}
export function rememberCountry(workspaceId: string, value: string) {
  try { localStorage.setItem(countryKey(workspaceId), value); } catch { /* a filter that forgets is still a filter */ }
}

export const pipelineDealsKey = (workspaceId: string, scope: DealScope, country: string | undefined) =>
  ["pipeline-deals", workspaceId, scope, country ?? "__ws_default__"] as const;

export async function fetchPipelineDeals(token: string, workspaceId: string, scope: DealScope, country: string | undefined): Promise<DealsPayload> {
  const r = await fetch(`${apiUrl}/api/companies/deals?workspaceId=${workspaceId}&status=all&scope=${scope}`
    + (country ? `&country=${encodeURIComponent(country)}` : ""), { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`deals_${r.status}`);
  const d = await r.json();
  return {
    deals: Array.isArray(d.deals) ? d.deals : [],
    primary_pipeline_ref: typeof d.primary_pipeline_ref === "string" && d.primary_pipeline_ref ? d.primary_pipeline_ref : null,
    country: typeof d.country === "string" && d.country ? d.country : null,
    scopeUnmapped: d.scope_unmapped === true,
  };
}

/** Every deal the viewer can see (open, won any age, lost in the last 12 months: the API's window). */
export function usePipelineDeals(scope: DealScope, country: string | undefined, enabled = true) {
  const { token, workspaceId, ready } = useWorkspaceAuth();
  return useQuery<DealsPayload>({
    queryKey: pipelineDealsKey(workspaceId, scope, country),
    enabled: ready && enabled,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
    queryFn: () => fetchPipelineDeals(token, workspaceId, scope, country),
  });
}

/** The CRM pipelines the viewer works. Same key and shape the Accounts list caches, so they share it. */
export function useCrmPipelines() {
  const { token, workspaceId, ready } = useWorkspaceAuth();
  return useQuery<{ pipelines: PipelineOption[]; names_ready: boolean }>({
    queryKey: ["crm-pipelines", workspaceId],
    enabled: ready,
    staleTime: 300_000,
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/crm-pipelines?workspaceId=${workspaceId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return { pipelines: [], names_ready: false };
      return r.json();
    },
  });
}

/** One pipeline's stage ladder, in order. Same key and shape the Accounts list caches. */
export function usePipelineStages(pipelineId: string) {
  const { token, workspaceId, ready } = useWorkspaceAuth();
  return useQuery<WsStage[]>({
    queryKey: ["workspace-stages", workspaceId, pipelineId],
    enabled: ready,
    staleTime: 300_000,
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/workspaces/${workspaceId}/stages`
        + (pipelineId !== "all" ? `?pipelineId=${encodeURIComponent(pipelineId)}` : ""), { headers: { Authorization: `Bearer ${token}` } });
      const d = r.ok ? await r.json() : {};
      return Array.isArray(d.stages) ? d.stages : [];
    },
  });
}

/** When HubSpot last synced, for the "synced N min ago" line. Null when there is no HubSpot sync. */
export function useCrmSyncedAt() {
  const { token, workspaceId, ready } = useWorkspaceAuth();
  return useQuery<{ connected: boolean; lastSyncedAt: string | null }>({
    queryKey: ["crm-sync-config", workspaceId, "hubspot"],
    enabled: ready,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/crm/sync-config?workspaceId=${workspaceId}&provider=hubspot`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return { connected: false, lastSyncedAt: null };
      const d = await r.json();
      const cfg = d?.config ?? null;
      return { connected: !!cfg, lastSyncedAt: typeof cfg?.last_synced_at === "string" ? cfg.last_synced_at : null };
    },
  });
}

/**
 * The accounts with a follow-up waiting: an open `follow_up_ready` flag, which the after-call run
 * files once per account. /api/flags is a short ranked list (100 open flags), so on a workspace
 * drowning in other flags a follow-up can fall off the end of it; good enough for a view preset.
 */
export function useFollowUpAccounts() {
  const { token, workspaceId, ready } = useWorkspaceAuth();
  return useQuery<Set<string>>({
    queryKey: ["pipeline-follow-ups", workspaceId],
    enabled: ready,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/flags?workspaceId=${workspaceId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return new Set<string>();
      const d = await r.json();
      const flags: { flag_type?: string; entity_id?: string }[] = Array.isArray(d?.flags) ? d.flags : [];
      return new Set(flags.filter((f) => f.flag_type === "follow_up_ready" && f.entity_id).map((f) => f.entity_id as string));
    },
  });
}
