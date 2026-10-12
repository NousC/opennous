import type { SupabaseClient } from '@supabase/supabase-js';

// Per-campaign provider analytics — the true funnel (sent/opened/replied/opportunities)
// the reply sample can't give us. Written by the campaign sync (refresh-on-read + a
// daily cron); read by the campaign_performance endpoint.

export interface CampaignStatInput {
  campaign_id: string;
  campaign_name?: string | null;
  status?: number | null;
  leads_count?: number | null;
  sent_count?: number | null;
  contacted_count?: number | null;
  reply_count?: number | null;
  opportunity_count?: number | null;
  bounced_count?: number | null;
  unsubscribed_count?: number | null;
  open_count?: number | null;
  raw?: unknown;
}

export interface CampaignStatRow extends CampaignStatInput {
  workspace_id: string;
  provider: string;
  fetched_at: string;
}

export async function upsertCampaignStats(
  supabase: SupabaseClient,
  workspaceId: string,
  provider: string,
  rows: CampaignStatInput[],
): Promise<void> {
  if (!rows.length) return;
  const now = new Date().toISOString();
  const payload = rows.map(r => ({
    workspace_id: workspaceId,
    provider,
    campaign_id: String(r.campaign_id),
    campaign_name: r.campaign_name ?? null,
    status: r.status ?? null,
    leads_count: r.leads_count ?? null,
    sent_count: r.sent_count ?? null,
    contacted_count: r.contacted_count ?? null,
    reply_count: r.reply_count ?? null,
    opportunity_count: r.opportunity_count ?? null,
    bounced_count: r.bounced_count ?? null,
    unsubscribed_count: r.unsubscribed_count ?? null,
    open_count: r.open_count ?? null,
    raw: r.raw ?? null,
    fetched_at: now,
  }));
  const { error } = await supabase
    .from('campaign_stats')
    .upsert(payload, { onConflict: 'workspace_id,provider,campaign_id' });
  if (error) throw error;
}

/** Latest stats per campaign → Map<campaign_id, row>. */
export async function getCampaignStats(
  supabase: SupabaseClient,
  workspaceId: string,
  provider: string,
  campaignIds: string[],
): Promise<Map<string, CampaignStatRow>> {
  const out = new Map<string, CampaignStatRow>();
  const ids = [...new Set(campaignIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase
      .from('campaign_stats')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('provider', provider)
      .in('campaign_id', ids.slice(i, i + 100));
    for (const r of (data as CampaignStatRow[] | null) ?? []) out.set(r.campaign_id, r);
  }
  return out;
}
