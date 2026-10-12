import { Router } from 'express';
import { getSupabaseClient, syncCampaigns, getCampaignStats, getInternalEntityIds, getPersonalEntityIds, normalizeStage, OPEN_STAGES, STAGE_RANK } from '@nous/core';
import { fetchIcpByEntity } from '../../lib/icpFit.mjs';
import { decrypt } from '../../providers/crypto.mjs';

export const campaignPerformanceV2Router = Router();

// GET /v2/campaigns/performance — the aggregate outbound feedback loop.
//
// Provider-generic (Instantly, lemlist, EmailBison, Smartlead, HeyReach). Three
// layers per campaign:
//   1. PROVIDER TRUTH  — the campaign's real funnel from the provider's analytics
//      (sent / contacted / replies / opportunities) → real RATES. Refreshed on read
//      (24h TTL). Only providers with a sync adapter carry this; the rest still get
//      layers 2-3.
//   2. OUR SAMPLE      — the replies we captured (any provider), classified pos/neu/
//      neg, with the replier's ICP tier, pipeline conversions, and days-to-client.
//   3. THE WHY         — the actual message COPY per step/variant + the recurring
//      OBJECTIONS/PAINS from the reply Intel.

const REPLY_PROPS = [
  'interaction.email_received', 'interaction.email_reply', 'interaction.email_replied',
  'interaction.linkedin_reply', 'interaction.linkedin_replied', 'interaction.linkedin_message_received',
  'interaction.positive_reply', 'interaction.reply',
];
const OBJECTION_CATEGORIES = new Set(['objection', 'pain', 'friction']);

const bucketOf = (sent) => sent === 'positive' ? 'positive' : sent === 'negative' ? 'negative' : 'neutral';
const emptyTier = () => ({ tier_1: 0, tier_2: 0, tier_3: 0, not_icp: 0 });
const median = (arr) => {
  if (!arr || !arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};
const rate = (num, den) => (den ? +(num / den).toFixed(3) : null);
const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function getProviderKey(supabase, ws, providerName) {
  const { data } = await supabase.from('workflow_provider_connections')
    .select('encrypted_credentials, workflow_providers!inner(name)')
    .eq('workspace_id', ws).eq('workflow_providers.name', providerName).eq('is_verified', true)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!data?.encrypted_credentials?.api_key) return null;
  try { return decrypt(data.encrypted_credentials.api_key); } catch { return null; }
}

campaignPerformanceV2Router.get('/performance', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const ws = req.workspaceId;

    // ── our captured replies (any provider) ──────────────────────────────────
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('observations')
        .select('entity_id, raw, observed_at, source')
        .eq('workspace_id', ws).eq('kind', 'event')
        .in('property', REPLY_PROPS)
        .not('raw->>campaign_id', 'is', null)
        .range(from, from + 999);
      if (error) throw error;
      if (!data?.length) break;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    if (!rows.length) return res.json({ campaigns: [], totals: { replies: 0, positive: 0, neutral: 0, negative: 0, conversions: 0, in_progress: 0, positive_rate: 0 } });

    const entityIds = [...new Set(rows.map(r => r.entity_id).filter(Boolean))];

    // Group campaigns by provider (the reply's source), so we sync + join per provider.
    const providerCampaigns = new Map();  // provider -> Set(campaign_id)
    for (const r of rows) {
      const cid = (r.raw || {}).campaign_id;
      const provider = r.source || 'unknown';
      if (!cid) continue;
      (providerCampaigns.get(provider) || providerCampaigns.set(provider, new Set()).get(provider)).add(cid);
    }

    // ── PROVIDER TRUTH: refresh-on-read (24h TTL) per provider, then load ──────
    const statsByKey = new Map();   // `${provider}|${cid}` -> stat row
    const copyByKey = new Map();    // `${provider}|${cid}|${step}` -> {subject, body}
    for (const [provider, cidSet] of providerCampaigns) {
      const ids = [...cidSet];
      const key = await getProviderKey(supabase, ws, provider);
      if (key) {
        try { await syncCampaigns(supabase, { provider, workspaceId: ws, apiKey: key, campaignIds: ids }); }
        catch (e) { console.warn(`[campaign-perf] ${provider} sync failed:`, e?.message || e); }
      }
      const stats = await getCampaignStats(supabase, ws, provider, ids);
      for (const [cid, s] of stats) statsByKey.set(`${provider}|${cid}`, s);
      for (let i = 0; i < ids.length; i += 100) {
        const { data } = await supabase.from('campaign_messages')
          .select('campaign_id, step, subject, body')
          .eq('workspace_id', ws).eq('provider', provider)
          .in('campaign_id', ids.slice(i, i + 100));
        for (const m of data || []) copyByKey.set(`${provider}|${m.campaign_id}|${m.step}`, m);
      }
    }

    // ── ICP, stage, conversion timing, first-reply attribution, objections ────
    const icp = await fetchIcpByEntity(supabase, ws, entityIds);

    // Internal (teammates) and personal contacts are asserted as claims, NOT columns
    // on the contacts view, so exclude them via the canonical claim-backed sets. (A
    // prior `select('is_personal, is_internal')` read columns that do not exist and
    // silently let teammates into campaign rollups.)
    const [internalIds, personalIds] = await Promise.all([
      getInternalEntityIds(supabase, ws),
      getPersonalEntityIds(supabase, ws),
    ]);
    const excluded = new Set([...internalIds, ...personalIds]);
    const stageByEntity = new Map();
    for (let i = 0; i < entityIds.length; i += 100) {
      const { data } = await supabase.from('contacts')
        .select('id, pipeline_stage')
        .in('id', entityIds.slice(i, i + 100));
      for (const c of data || []) stageByEntity.set(c.id, { stage: c.pipeline_stage || null, skip: excluded.has(c.id) });
    }

    const clientAt = new Map();
    for (let i = 0; i < entityIds.length; i += 100) {
      const { data } = await supabase.from('observations')
        .select('entity_id, value, observed_at')
        .eq('workspace_id', ws).eq('property', 'pipeline_stage')
        .in('entity_id', entityIds.slice(i, i + 100))
        .order('observed_at', { ascending: true });
      for (const o of data || []) {
        const v = typeof o.value === 'string' ? o.value : String(o.value ?? '');
        // Normalize: the win stage is `closed_won` now, but this is the historical
        // observation log and old rows still say `client`. A raw === check would
        // find nothing after the rename and every days-to-client would go null.
        if (normalizeStage(v) === 'closed_won' && !clientAt.has(o.entity_id)) clientAt.set(o.entity_id, o.observed_at);
      }
    }

    const firstReply = new Map();
    for (const r of rows) {
      const cid = (r.raw || {}).campaign_id;
      if (!cid || !r.observed_at) continue;
      const cur = firstReply.get(r.entity_id);
      if (!cur || new Date(r.observed_at) < new Date(cur.at)) firstReply.set(r.entity_id, { campaign_id: cid, at: r.observed_at });
    }

    const objByEntity = new Map();
    for (let i = 0; i < entityIds.length; i += 100) {
      const { data } = await supabase.from('claims')
        .select('entity_id, value')
        .eq('workspace_id', ws).like('property', 'note.%')
        .in('entity_id', entityIds.slice(i, i + 100)).is('invalid_at', null);
      for (const c of data || []) {
        const cat = (c.value?.category || '').toLowerCase();
        if (!OBJECTION_CATEGORIES.has(cat)) continue;
        const content = c.value?.content;
        if (!content) continue;
        (objByEntity.get(c.entity_id) || objByEntity.set(c.entity_id, []).get(c.entity_id)).push(content);
      }
    }

    // ── aggregate our sample by campaign → step ───────────────────────────────
    const camps = new Map();
    for (const r of rows) {
      const raw = r.raw || {};
      const cid = raw.campaign_id;
      if (!cid) continue;
      let c = camps.get(cid);
      if (!c) { c = { campaign_id: cid, provider: r.source || 'unknown', campaign_name: raw.campaign_name || null, replies: 0, positive: 0, neutral: 0, negative: 0, icpSum: 0, icpN: 0, tier_of_positive: emptyTier(), conversions: 0, in_progress: 0, daysList: [], objections: new Set(), steps: new Map() }; camps.set(cid, c); }
      if (!c.campaign_name && raw.campaign_name) c.campaign_name = raw.campaign_name;

      const b = bucketOf(raw.sentiment);
      c.replies++; c[b]++;

      const stepKey = raw.step ?? '—';
      let s = c.steps.get(stepKey);
      if (!s) { s = { step: raw.step ?? null, replies: 0, positive: 0, neutral: 0, negative: 0 }; c.steps.set(stepKey, s); }
      s.replies++; s[b]++;

      if (b === 'positive') {
        const fit = icp.get(r.entity_id);
        if (fit) { c.icpSum += fit.score; c.icpN++; const t = fit.tier || 'not_icp'; if (c.tier_of_positive[t] != null) c.tier_of_positive[t]++; }
      }
    }

    for (const [eid, fr] of firstReply) {
      const st = stageByEntity.get(eid);
      if (!st || st.skip) continue;
      const c = camps.get(fr.campaign_id);
      if (!c) continue;
      // The contacts view still serves un-migrated stage values, so normalize
      // before comparing — never match the raw string.
      const stage = normalizeStage(st.stage);
      if (stage === 'closed_won') {
        c.conversions++;
        const ca = clientAt.get(eid);
        if (ca) c.daysList.push((new Date(ca) - new Date(fr.at)) / 86400000);
      } else if (stage && OPEN_STAGES.has(stage) && STAGE_RANK[stage] >= STAGE_RANK.meeting_booked) {
        // in_progress = a live deal from this campaign, not yet won. The old code
        // counted the single `evaluating` stage, which covered everything between a
        // booked meeting and a signature. That stage is gone, so the replacement is
        // the open ladder from meeting_booked up. A lead that only replied
        // (interested) is still just a reply and stays out, same as before.
        c.in_progress++;
      }
      for (const o of objByEntity.get(eid) || []) c.objections.add(o);
    }

    const campaigns = [...camps.values()].map(c => {
      const st = statsByKey.get(`${c.provider}|${c.campaign_id}`);
      const provider_totals = st ? {
        leads: st.leads_count, sent: st.sent_count, contacted: st.contacted_count,
        replies: st.reply_count, opportunities: st.opportunity_count,
        bounced: st.bounced_count, unsubscribed: st.unsubscribed_count, status: st.status,
        fetched_at: st.fetched_at,
      } : null;
      const provider_rates = st ? {
        reply_rate: rate(st.reply_count, st.contacted_count),
        opportunity_rate: rate(st.opportunity_count, st.contacted_count),
      } : null;
      return {
        campaign_id: c.campaign_id,
        provider: c.provider,
        campaign_name: c.campaign_name,
        provider_totals,
        provider_rates,
        captured: {
          replies: c.replies, positive: c.positive, neutral: c.neutral, negative: c.negative,
          positive_rate: c.replies ? +(c.positive / c.replies).toFixed(2) : 0,
        },
        avg_icp_of_positive: c.icpN ? Math.round(c.icpSum / c.icpN) : null,
        tier_of_positive: c.tier_of_positive,
        conversions: c.conversions,
        in_progress: c.in_progress,
        median_days_to_client: median(c.daysList),
        top_objections: [...c.objections].slice(0, 8),
        steps: [...c.steps.values()]
          .map(s => {
            const copy = copyByKey.get(`${c.provider}|${c.campaign_id}|${s.step}`);
            return {
              step: s.step,
              replies: s.replies, positive: s.positive, neutral: s.neutral, negative: s.negative,
              positive_rate: s.replies ? +(s.positive / s.replies).toFixed(2) : 0,
              subject: copy?.subject ?? null,
              body_preview: copy?.body ? stripHtml(copy.body).slice(0, 280) : null,
            };
          })
          .sort((a, b) => String(a.step).localeCompare(String(b.step))),
      };
    }).sort((a, b) => b.conversions - a.conversions || b.captured.positive - a.captured.positive || b.captured.replies - a.captured.replies);

    const totals = campaigns.reduce((t, c) => {
      t.replies += c.captured.replies; t.positive += c.captured.positive; t.neutral += c.captured.neutral; t.negative += c.captured.negative;
      t.conversions += c.conversions; t.in_progress += c.in_progress;
      if (c.provider_totals) { t.sent += c.provider_totals.sent || 0; t.provider_replies += c.provider_totals.replies || 0; t.opportunities += c.provider_totals.opportunities || 0; }
      return t;
    }, { replies: 0, positive: 0, neutral: 0, negative: 0, conversions: 0, in_progress: 0, sent: 0, provider_replies: 0, opportunities: 0 });
    totals.positive_rate = totals.replies ? +(totals.positive / totals.replies).toFixed(2) : 0;

    return res.json({ campaigns, totals });
  } catch (err) {
    console.error('[GET /v2/campaigns/performance]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
