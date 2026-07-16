import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';

export const reportV2Router = Router();

// POST /v2/report — the cross-channel outbound funnel, entity-grained.
//
// query's aggregating sibling: query returns rows, report returns COUNTS. Every
// metric is COUNT(DISTINCT entity_id), never COUNT(*) — because the touches
// arrived on different channels under different identities (a LinkedIn URL, an
// email) and Nous already resolved them to ONE entity_id. So a person hit on
// LinkedIn AND email is ONE person in `totals` and appears in BOTH channel rows:
// channel rows OVERLAP and must never be summed to a total. No sequencer can
// produce this number — that's the whole point.
//
// Body: {
//   window?:    { from?: ISO, to?: ISO },     // default: last 7 days
//   group_by?:  ('channel'|'campaign'|'day')[],
//   campaign_id?: string,                      // filter to one campaign
//   metrics?:   string[]                       // accepted; all are always returned
// }

// Channel is DERIVED from the connector that wrote the observation — both live in
// the same observations table, tagged by source.
const EMAIL_SOURCES = new Set(['instantly', 'smartlead', 'lemlist', 'emailbison']);
const LINKEDIN_SOURCES = new Set(['heyreach', 'linkedin', 'unipile']);
const MEETING_SOURCES = new Set(['calcom', 'cal.com', 'calendly']);
function channelOf(source) {
  const s = String(source || '').toLowerCase();
  if (EMAIL_SOURCES.has(s)) return 'email';
  if (LINKEDIN_SOURCES.has(s)) return 'linkedin';
  if (MEETING_SOURCES.has(s)) return 'meeting';
  return 'other';
}

// Metric membership — a predicate over one observation. is_outbound (already on
// the obs) splits "we messaged them" from "they replied"; sentiment (written by
// the reply handlers) makes `positive` real, not just "any reply".
const outbound = o => o.raw?.is_outbound === true;
const inbound = o => o.raw?.is_outbound === false;
const isReply = o =>
  o.property === 'interaction.email_replied' ||
  o.property === 'interaction.email_received' ||
  (o.property === 'interaction.linkedin_message' && inbound(o));
const METRICS = {
  reached: o => o.property === 'interaction.added_to_campaign'
    || (o.property === 'interaction.linkedin_message' && outbound(o)),
  connected: o => o.property === 'interaction.linkedin_connected',
  replied: isReply,
  positive: o => isReply(o) && o.raw?.sentiment === 'positive',
  meetings: o => o.property === 'interaction.meeting_held'
    || o.property === 'interaction.meeting_booked',
};
const METRIC_KEYS = Object.keys(METRICS);

// DISTINCT-entity count per metric over a set of observations. An entity counts
// toward a metric if ANY of its observations match — so multiple touches on the
// same channel collapse to one person for free.
function tally(obs) {
  const sets = {};
  for (const m of METRIC_KEYS) sets[m] = new Set();
  for (const o of obs) {
    for (const m of METRIC_KEYS) if (METRICS[m](o)) sets[m].add(o.entity_id);
  }
  const out = {};
  for (const m of METRIC_KEYS) out[m] = sets[m].size;
  return out;
}

// Window-bounded fetch cap. If a workspace has more interaction events than this
// in the window, totals are a FLOOR — surfaced in the response, never silent.
const FETCH_CAP = 50000;

reportV2Router.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const ws = req.workspaceId;
    const { window: win = {}, group_by = [], campaign_id, lead_list_id } = req.body || {};
    const dims = (Array.isArray(group_by) ? group_by : [group_by]).filter(Boolean);

    const to = win.to ? new Date(win.to) : new Date();
    const from = win.from ? new Date(win.from) : new Date(to.getTime() - 7 * 86400000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ error: 'invalid_window' });
    }

    // One window-bounded fetch over the interaction events; aggregation is in JS
    // (COUNT DISTINCT FILTER isn't expressible through PostgREST). entity_id is
    // NOT NULL so only resolved touches count — the unresolved tail is reported.
    const { data, error } = await supabase
      .from('observations')
      .select('entity_id, property, source, observed_at, raw')
      .eq('workspace_id', ws).eq('kind', 'event')
      .like('property', 'interaction.%')
      .not('entity_id', 'is', null)
      .gte('observed_at', from.toISOString())
      .lt('observed_at', to.toISOString())
      .order('observed_at', { ascending: false })
      .limit(FETCH_CAP + 1);
    if (error) throw error;

    let rows = data || [];
    const truncated = rows.length > FETCH_CAP;
    if (truncated) rows = rows.slice(0, FETCH_CAP);
    if (campaign_id) rows = rows.filter(o => (o.raw?.campaign_id ?? null) === campaign_id);

    // Scope to a lead list (= a campaign): keep only events on that list's leads.
    // The list's entity ids == lead ids; filter the obs to that set in JS so a
    // 2k-id `.in()` never blows the query-string limit.
    if (lead_list_id) {
      const { data: listLeads } = await supabase
        .from('leads').select('id').eq('workspace_id', ws).eq('lead_list_id', lead_list_id).limit(50000);
      const inList = new Set((listLeads || []).map(l => l.id));
      rows = rows.filter(o => inList.has(o.entity_id));
    }

    const totals = tally(rows);

    // group_by is just which key the DISTINCT collapses under.
    let by = [];
    if (dims.length) {
      const keyOf = (o) => dims.map(d =>
        d === 'channel' ? channelOf(o.source)
          : d === 'campaign' ? (o.raw?.campaign_id ?? 'none')
          : d === 'day' ? new Date(o.observed_at).toISOString().slice(0, 10)
          : 'all'
      ).join(' · ');
      const groups = new Map();
      for (const o of rows) {
        const k = keyOf(o);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(o);
      }
      by = [...groups.entries()].map(([key, gobs]) => {
        const row = { key, ...tally(gobs) };
        if (dims.includes('campaign')) {
          row.campaign_name = gobs.find(o => o.raw?.campaign_name)?.raw?.campaign_name ?? null;
        }
        return row;
      }).sort((a, b) => (b.reached - a.reached) || (b.replied - a.replied));
    }

    // Cross-channel overlap: entities REACHED on BOTH LinkedIn and email — the
    // stat only identity resolution can produce. NEVER sum channel rows to a total.
    const liReached = new Set(), emReached = new Set();
    for (const o of rows) {
      if (!METRICS.reached(o)) continue;
      const ch = channelOf(o.source);
      if (ch === 'linkedin') liReached.add(o.entity_id);
      else if (ch === 'email') emReached.add(o.entity_id);
    }
    let both = 0;
    for (const e of liReached) if (emReached.has(e)) both++;

    const rate = (n) => totals.reached ? Number((n / totals.reached).toFixed(4)) : 0;

    return res.json({
      window: { from: from.toISOString(), to: to.toISOString() },
      totals,
      by,
      overlap: { linkedin_reached: liReached.size, email_reached: emReached.size, both_channels: both },
      rates: {
        reply_rate: rate(totals.replied),
        positive_rate: rate(totals.positive),
        meeting_rate: rate(totals.meetings),
      },
      ...(truncated ? { truncated: true, note: `capped at ${FETCH_CAP} events — totals are a floor; narrow the window or filter by campaign` } : {}),
    });
  } catch (err) {
    console.error('[POST /v2/report]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
