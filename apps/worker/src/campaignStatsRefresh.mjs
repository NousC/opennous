// Daily refresh of campaign analytics (sent/opened/replied/opportunities) from each
// connected outbound provider. The campaign_performance endpoint also refreshes on
// read (24h TTL); this is the backstop that keeps stats warm for campaigns nobody
// queried. force:true because this IS the daily refresh.
//
// Provider-generic: for every verified outbound connection, refresh the campaigns we
// have replies for from THAT provider. Only providers with a sync adapter in
// @nous/core actually fetch; the rest no-op.

import { getSupabaseClient, syncCampaigns } from '@nous/core';
import { decrypt } from './utils/encryption.mjs';
import { enrichInstantlyEmailBodies, backfillReplierSentEmails } from './services/instantlyEmails.mjs';

const DAY = 86_400_000;
const OUTBOUND_PROVIDERS = new Set(['instantly', 'lemlist', 'emailbison', 'smartlead', 'heyreach']);

export async function campaignStatsRefreshCron() {
  const supabase = getSupabaseClient();
  const { data: conns } = await supabase
    .from('workflow_provider_connections')
    .select('workspace_id, encrypted_credentials, workflow_providers!inner(name)')
    .eq('is_verified', true);

  let total = 0;
  for (const conn of conns || []) {
    const provider = conn.workflow_providers?.name;
    if (!OUTBOUND_PROVIDERS.has(provider)) continue;
    const ws = conn.workspace_id;
    let key = null;
    try { key = conn.encrypted_credentials?.api_key ? decrypt(conn.encrypted_credentials.api_key) : null; } catch { key = null; }
    if (!key) continue;

    // Campaigns THIS provider has produced replies for in the last 180 days.
    const { data: obs } = await supabase.from('observations')
      .select('raw')
      .eq('workspace_id', ws).eq('kind', 'event').eq('source', provider)
      .not('raw->>campaign_id', 'is', null)
      .gte('observed_at', new Date(Date.now() - 180 * DAY).toISOString())
      .limit(5000);
    const campaignIds = [...new Set((obs || []).map(o => o.raw?.campaign_id).filter(Boolean))];
    if (!campaignIds.length) continue;

    try {
      const { refreshed } = await syncCampaigns(supabase, { provider, workspaceId: ws, apiKey: key, campaignIds, force: true });
      if (refreshed.length) { total += refreshed.length; console.log(`[CAMPAIGN_STATS] ws=${ws} provider=${provider} refreshed ${refreshed.length} campaign(s)`); }
    } catch (e) {
      console.warn(`[CAMPAIGN_STATS] ws=${ws} provider=${provider} failed:`, e?.message || e);
    }

    // Instantly-only: for everyone who REPLIED, pull the exact email(s) we sent
    // them (by lead) and save the outbound thread with real bodies — so each reply
    // has the conversation it answered. Non-repliers are covered by the campaign
    // copy, so we never store the same campaign email per person. Also enrich any
    // existing subject-only sent rows. Both best-effort; both skip already-done work.
    if (provider === 'instantly') {
      try {
        await enrichInstantlyEmailBodies(supabase, { workspaceId: ws, apiKey: key, campaignIds });
      } catch (e) {
        console.warn(`[CAMPAIGN_STATS] ws=${ws} email-body enrich failed:`, e?.message || e);
      }
      try {
        await backfillReplierSentEmails(supabase, { workspaceId: ws, apiKey: key });
      } catch (e) {
        console.warn(`[CAMPAIGN_STATS] ws=${ws} replier-sent backfill failed:`, e?.message || e);
      }
    }
  }
  return { refreshed: total };
}
