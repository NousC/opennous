import type { SupabaseClient } from '@supabase/supabase-js';
import { upsertCampaignStats, type CampaignStatInput } from '../db/campaignStats.js';
import { upsertCampaignMessage } from '../db/campaignMessages.js';

// Pull a campaign's real analytics + its sequence copy from the outbound provider
// and store them (campaign_stats + campaign_messages), keyed by (workspace, provider,
// campaign_id). TTL-aware, so it's safe to call on every read. The caller resolves +
// passes the workspace's provider API key.
//
// Provider-generic: `syncCampaigns` dispatches to a per-provider FETCHER. The reply
// side of campaign_performance is already provider-agnostic (any provider's replies
// land as observations); this is the only provider-specific layer. Adding a new
// engagement platform = add one fetcher below.
//
// Sequence copy is keyed by "seqIdx_stepIdx_variantIdx" (e.g. "0_3_0") — the same
// code the provider stamps on a reply's `step`, so the campaign_performance join
// lands each reply on the exact message that earned it.

export interface ProviderCampaignData {
  stats: CampaignStatInput[];
  copy: Array<{ campaignId: string; campaignName?: string | null; step: string; subject?: string | null; body?: string | null }>;
}

type Fetcher = (apiKey: string, campaignIds: string[]) => Promise<ProviderCampaignData>;

async function httpJson(url: string, headers: Record<string, string>, init?: RequestInit): Promise<any> {
  const r = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

const num = (x: unknown): number | null =>
  typeof x === 'number' ? x : (x != null && x !== '' && !Number.isNaN(Number(x)) ? Number(x) : null);

// ── Instantly (Bearer) ────────────────────────────────────────────────────────
const fetchInstantly: Fetcher = async (apiKey, campaignIds) => {
  const H = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const out: ProviderCampaignData = { stats: [], copy: [] };

  let analytics: any[] = [];
  try {
    const a = await httpJson('https://api.instantly.ai/api/v2/campaigns/analytics', H);
    analytics = Array.isArray(a) ? a : (a?.items ?? []);
  } catch { /* no stats */ }
  const byId = new Map<string, any>(analytics.map((c: any) => [c.campaign_id, c]));

  for (const id of campaignIds) {
    const a = byId.get(id);
    if (a) out.stats.push({
      campaign_id: id, campaign_name: a.campaign_name ?? null, status: a.campaign_status ?? null,
      leads_count: a.leads_count ?? null, sent_count: a.emails_sent_count ?? null,
      contacted_count: a.new_leads_contacted_count ?? null,
      reply_count: a.reply_count_unique ?? a.reply_count ?? null,
      opportunity_count: a.total_opportunities ?? null,
      bounced_count: a.bounced_count ?? null, unsubscribed_count: a.unsubscribed_count ?? null,
      open_count: a.open_count_unique ?? a.open_count ?? null, raw: a,
    });
    try {
      const detail = await httpJson(`https://api.instantly.ai/api/v2/campaigns/${encodeURIComponent(id)}`, H);
      const name = detail?.name ?? a?.campaign_name ?? null;
      const seqs = detail?.sequences ?? [];
      for (let si = 0; si < seqs.length; si++) {
        const steps = seqs[si]?.steps ?? [];
        for (let ti = 0; ti < steps.length; ti++) {
          const variants = steps[ti]?.variants ?? [];
          for (let vi = 0; vi < variants.length; vi++) {
            const v = variants[vi] ?? {};
            out.copy.push({ campaignId: id, campaignName: name, step: `${si}_${ti}_${vi}`, subject: v.subject ?? null, body: v.body ?? null });
          }
        }
      }
    } catch { /* no copy for this campaign */ }
  }
  return out;
};

// ── Smartlead (api_key query param) ───────────────────────────────────────────
// GET /campaigns/{id}/analytics + GET /campaigns/{id}/sequences.
// Built to the documented endpoints; field names are best-effort and degrade to
// null until confirmed against a live Smartlead workspace. Never throws upward.
const fetchSmartlead: Fetcher = async (apiKey, campaignIds) => {
  const out: ProviderCampaignData = { stats: [], copy: [] };
  const base = 'https://server.smartlead.ai/api/v1';
  const q = `api_key=${encodeURIComponent(apiKey)}`;
  for (const id of campaignIds) {
    try {
      const a = await httpJson(`${base}/campaigns/${encodeURIComponent(id)}/analytics?${q}`, {});
      const ls = a?.campaign_lead_stats ?? {};
      out.stats.push({
        campaign_id: id, campaign_name: a?.name ?? null, status: null,
        leads_count: num(ls.total ?? a?.total_count), sent_count: num(a?.sent_count),
        contacted_count: num(ls.total ?? a?.sent_count), reply_count: num(a?.reply_count),
        opportunity_count: num(ls.interested ?? a?.interested_count),
        bounced_count: num(a?.bounce_count), unsubscribed_count: num(a?.unsubscribed_count),
        open_count: num(a?.unique_open_count ?? a?.open_count), raw: a,
      });
    } catch { /* no stats */ }
    try {
      const seq = await httpJson(`${base}/campaigns/${encodeURIComponent(id)}/sequences?${q}`, {});
      const steps = Array.isArray(seq) ? seq : (seq?.data ?? []);
      steps.forEach((st: any, ti: number) => {
        const variants = st.sequence_variants ?? st.variants ?? [{ subject: st.subject, email_body: st.email_body }];
        variants.forEach((v: any, vi: number) => out.copy.push({ campaignId: id, step: `0_${ti}_${vi}`, subject: v.subject ?? null, body: v.email_body ?? v.body ?? null }));
      });
    } catch { /* no copy */ }
  }
  return out;
};

// ── lemlist (HTTP Basic, key as password) ─────────────────────────────────────
// GET /campaigns/{id}/stats + GET /campaigns/{id}/sequences. Best-effort mapping.
const fetchLemlist: Fetcher = async (apiKey, campaignIds) => {
  const out: ProviderCampaignData = { stats: [], copy: [] };
  const base = 'https://api.lemlist.com/api';
  const H = { Authorization: `Basic ${Buffer.from(`:${apiKey}`).toString('base64')}`, 'Content-Type': 'application/json' };
  for (const id of campaignIds) {
    try {
      const s = await httpJson(`${base}/campaigns/${encodeURIComponent(id)}/stats`, H);
      out.stats.push({
        campaign_id: id, campaign_name: s?.name ?? null, status: null,
        leads_count: num(s?.nbContacted ?? s?.nbLeads), sent_count: num(s?.nbEmailsSent ?? s?.nbSent),
        contacted_count: num(s?.nbContacted ?? s?.nbLeads), reply_count: num(s?.nbReplied ?? s?.nbRepliers),
        opportunity_count: num(s?.nbInterested), bounced_count: num(s?.nbBounced),
        unsubscribed_count: num(s?.nbUnsubscribed), open_count: num(s?.nbOpen ?? s?.nbOpened), raw: s,
      });
    } catch { /* no stats */ }
    try {
      const seqs = await httpJson(`${base}/campaigns/${encodeURIComponent(id)}/sequences`, H);
      const steps = seqs?.steps ?? (Array.isArray(seqs) ? seqs : (seqs?.sequences ?? []));
      steps.forEach((st: any, ti: number) => out.copy.push({ campaignId: id, step: `0_${ti}_0`, subject: st.subject ?? null, body: st.body ?? st.content ?? st.html ?? null }));
    } catch { /* no copy */ }
  }
  return out;
};

// ── HeyReach (X-API-KEY, POST) — LinkedIn, so "copy" is the message text ───────
// POST /stats/GetOverallStats + GET /campaign/GetCampaignSequence. Best-effort.
const fetchHeyreach: Fetcher = async (apiKey, campaignIds) => {
  const out: ProviderCampaignData = { stats: [], copy: [] };
  const base = 'https://api.heyreach.io/api/public';
  const H = { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' };
  for (const id of campaignIds) {
    try {
      const s = await httpJson(`${base}/stats/GetOverallStats`, H, { method: 'POST', body: JSON.stringify({ campaignIds: [Number(id) || id], accountIds: [] }) });
      const c = s?.byCampaign?.[0] ?? s?.overallStats ?? s ?? {};
      out.stats.push({
        campaign_id: id, campaign_name: c?.campaignName ?? null, status: null,
        leads_count: num(c?.totalLeads ?? c?.leadsCount), sent_count: num(c?.messagesSent ?? c?.messageSentCount),
        contacted_count: num(c?.totalLeads ?? c?.connectionsSent), reply_count: num(c?.replies ?? c?.messageRepliedCount),
        opportunity_count: num(c?.interested), bounced_count: null, unsubscribed_count: null, open_count: null, raw: s,
      });
    } catch { /* no stats */ }
    try {
      const seq = await httpJson(`${base}/campaign/GetCampaignSequence?campaignId=${encodeURIComponent(id)}`, H);
      const steps = seq?.steps ?? seq?.sequence?.steps ?? (Array.isArray(seq) ? seq : []);
      steps.forEach((st: any, ti: number) => out.copy.push({ campaignId: id, step: `0_${ti}_0`, subject: null, body: st.message ?? st.text ?? st.body ?? null }));
    } catch { /* no copy */ }
  }
  return out;
};

// ── EmailBison (Bearer) — least publicly documented, so most defensive ─────────
const fetchEmailbison: Fetcher = async (apiKey, campaignIds) => {
  const out: ProviderCampaignData = { stats: [], copy: [] };
  const base = 'https://api.emailbison.com';
  const H = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  for (const id of campaignIds) {
    try {
      const a = await httpJson(`${base}/api/campaigns/${encodeURIComponent(id)}/statistics`, H);
      const s = a?.data ?? a ?? {};
      out.stats.push({
        campaign_id: id, campaign_name: s?.name ?? null, status: null,
        leads_count: num(s?.leads_count ?? s?.total_leads), sent_count: num(s?.sent ?? s?.emails_sent),
        contacted_count: num(s?.contacted ?? s?.leads_count), reply_count: num(s?.replies ?? s?.replied),
        opportunity_count: num(s?.interested), bounced_count: num(s?.bounced),
        unsubscribed_count: num(s?.unsubscribed), open_count: num(s?.opens ?? s?.opened), raw: a,
      });
    } catch { /* no stats */ }
    try {
      const seq = await httpJson(`${base}/api/campaigns/${encodeURIComponent(id)}/sequence-steps`, H);
      const steps = seq?.data ?? (Array.isArray(seq) ? seq : (seq?.steps ?? []));
      steps.forEach((st: any, ti: number) => out.copy.push({ campaignId: id, step: `0_${ti}_0`, subject: st.subject ?? null, body: st.body ?? st.content ?? st.email_body ?? null }));
    } catch { /* no copy */ }
  }
  return out;
};

// Per-provider fetchers. Instantly is implemented + verified against live data.
// The others are built to each provider's documented endpoints; their exact field
// names are best-effort and degrade to null (never crash) until confirmed against a
// workspace that has real data. Every fetch is wrapped, so a wrong path just yields
// an empty layer — the reply-sample side of campaign_performance is unaffected.
const FETCHERS: Record<string, Fetcher> = {
  instantly: fetchInstantly,
  smartlead: fetchSmartlead,
  lemlist: fetchLemlist,
  heyreach: fetchHeyreach,
  emailbison: fetchEmailbison,
};

export async function syncCampaigns(
  supabase: SupabaseClient,
  opts: { provider: string; workspaceId: string; apiKey: string; campaignIds: string[]; ttlHours?: number; force?: boolean },
): Promise<{ refreshed: string[] }> {
  const { provider, workspaceId, apiKey, campaignIds, ttlHours = 24, force = false } = opts;
  const fetcher = FETCHERS[provider];
  if (!fetcher || !apiKey || !campaignIds?.length) return { refreshed: [] };

  let stale = [...new Set(campaignIds.filter(Boolean))];
  if (!force) {
    const cutoff = new Date(Date.now() - ttlHours * 3_600_000).toISOString();
    const { data: fresh } = await supabase.from('campaign_stats')
      .select('campaign_id')
      .eq('workspace_id', workspaceId).eq('provider', provider)
      .in('campaign_id', stale).gte('fetched_at', cutoff);
    const freshSet = new Set((fresh ?? []).map((r: { campaign_id: string }) => r.campaign_id));
    stale = stale.filter(id => !freshSet.has(id));
  }
  if (!stale.length) return { refreshed: [] };

  let data: ProviderCampaignData;
  try { data = await fetcher(apiKey, stale); }
  catch { return { refreshed: [] }; }

  if (data.stats.length) await upsertCampaignStats(supabase, workspaceId, provider, data.stats);
  for (const m of data.copy) {
    await upsertCampaignMessage(supabase, workspaceId, {
      provider, campaignId: m.campaignId, campaignName: m.campaignName ?? null,
      step: m.step, variant: '', subject: m.subject ?? null, body: m.body ?? null,
      source: `${provider}_api`,
    }).catch(() => {});
  }
  return { refreshed: stale };
}

/** Back-compat thin wrapper. */
export async function syncInstantlyCampaigns(
  supabase: SupabaseClient,
  opts: { workspaceId: string; apiKey: string; campaignIds: string[]; ttlHours?: number; force?: boolean },
): Promise<{ refreshed: string[] }> {
  return syncCampaigns(supabase, { provider: 'instantly', ...opts });
}
