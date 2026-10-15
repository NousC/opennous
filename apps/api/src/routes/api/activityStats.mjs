// /api/activity-stats — what's going on in the business.
//
// The Activities page used to lead with "total ops", "failed ops", "system /
// agent". Those describe the machine, not the work. Nobody opens this page asking
// how many HTTP calls succeeded; they open it asking whether anything is
// happening — are we talking to people, are they talking back, are meetings
// getting booked.
//
// So these numbers come from the graph (what actually happened with humans), not
// from the op log (what the software did). Deliberately nothing to do with Nous
// usage — that lives on Adoption.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';

export const activityStatsRouter = Router();

const DAY = 86_400_000;
const PAGE = 1000;

// The interactions that are a real conversation with a human.
const OUTBOUND = /email_sent|linkedin_message_sent|message_sent|sequence|campaign/;
const INBOUND  = /replied|reply|received|inbound/;
const MEETING_HELD  = /meeting_held|call_held/;
const MEETING_BOOKED = /meeting_scheduled|meeting_booked/;

// The canonical set of ACTIONS we surface in the audit feed — the moves that come
// off the connected tools. Each maps a raw interaction.* property to a readable label,
// a channel (for the logo), and whether it's an outbound move or the meeting itself.
const ACTION_LABELS = {
  'interaction.email_sent':            { label: 'Email sent',             channel: 'email',    dir: 'out' },
  'interaction.linkedin_message_sent': { label: 'LinkedIn message sent',  channel: 'linkedin', dir: 'out' },
  'interaction.linkedin_invite_sent':  { label: 'LinkedIn request sent',  channel: 'linkedin', dir: 'out' },
  'interaction.linkedin_message':      { label: 'LinkedIn message sent',  channel: 'linkedin', dir: 'out' },
  'interaction.call':                  { label: 'Call',                   channel: 'call',     dir: 'out' },
  'interaction.call_held':             { label: 'Call held',              channel: 'call',     dir: 'engagement' },
  'interaction.meeting_scheduled':     { label: 'Meeting booked',         channel: 'meeting',  dir: 'out' },
  'interaction.meeting_booked':        { label: 'Meeting booked',         channel: 'meeting',  dir: 'out' },
  // A provider disposition (e.g. Instantly lead_meeting_booked), NOT a confirmed
  // calendar event — distinct label + kept out of MEETING_BOOKED so booked stats
  // only count real calendar meetings.
  'interaction.meeting_interest':      { label: 'Meeting interest',       channel: 'meeting',  dir: 'engagement' },
  'interaction.meeting_held':          { label: 'Meeting held',           channel: 'meeting',  dir: 'engagement' },
};
const ACTION_PROPS = Object.keys(ACTION_LABELS);

// GET /api/activity-stats/feed — the audit feed: recent ACTIONS (email/LinkedIn/meeting)
// as readable items, each tied back to the recommendation that prompted it when the
// action came from a Studio draft. This is the Action layer of the decision trace.
activityStatsRouter.get('/feed', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const daysParam = req.query.days;
    const days = daysParam === 'all' ? null : Math.min(Math.max(parseInt(daysParam, 10) || 30, 1), 365);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 60, 1), 200);
    const supabase = getSupabaseClient();

    let q = supabase.from('observations')
      .select('id, entity_id, property, value, raw, source, observed_at')
      .eq('workspace_id', workspaceId)
      .in('property', ACTION_PROPS)
      .order('observed_at', { ascending: false })
      .limit(limit);
    if (days != null) q = q.gte('observed_at', new Date(Date.now() - days * DAY).toISOString());
    // Personal view: only the actions this member owns.
    if (req.query.mine === '1' && req.memberUserId) q = q.eq('owner_user_id', req.memberUserId);
    const { data: rows } = await q;
    const items = rows ?? [];

    // Resolve who each action was with (person or company).
    const entityIds = [...new Set(items.map((r) => r.entity_id).filter(Boolean))];
    const nameById = new Map();
    if (entityIds.length) {
      const [{ data: cs }, { data: cos }] = await Promise.all([
        supabase.from('contacts').select('id, first_name, last_name, company').in('id', entityIds),
        supabase.from('companies').select('id, name').in('id', entityIds),
      ]);
      for (const c of cs ?? []) nameById.set(c.id, [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || null);
      for (const c of cos ?? []) if (!nameById.has(c.id)) nameById.set(c.id, c.name);
    }

    // Resolve the recommendation each Studio-sent action traces back to.
    const recIds = [...new Set(items.map((r) => r.raw?.rec_id).filter(Boolean))];
    const recById = new Map();
    if (recIds.length) {
      const { data: recs } = await supabase.from('ri_recommendations').select('id, category, text').in('id', recIds);
      for (const rc of recs ?? []) recById.set(rc.id, { category: rc.category, text: rc.text });
    }

    const feed = items.map((r) => {
      // `interaction.linkedin_message` carries both directions on one property — this
      // is an ACTIONS feed, so keep only the ones the operator SENT (raw.is_outbound).
      if (r.property === 'interaction.linkedin_message' && r.raw?.is_outbound !== true) return null;
      const meta = ACTION_LABELS[r.property] ?? { label: String(r.property).replace(/^interaction\./, '').replace(/_/g, ' '), channel: 'other', dir: 'out' };
      const rec = r.raw?.rec_id ? recById.get(r.raw.rec_id) : null;
      const v = r.value || {};
      return {
        id: r.id,
        label: meta.label,
        channel: meta.channel,
        direction: meta.dir,
        entity_id: r.entity_id,
        entity_name: nameById.get(r.entity_id) ?? null,
        detail: v.subject ?? (typeof v.text === 'string' ? v.text.slice(0, 110) : null),
        // Did this come from a Nous approval (Studio / the agent), vs a passive sync?
        from_nous: v.sent_by === 'agent' || v.approved === true,
        from_rec: rec ? { category: rec.category, text: rec.text } : null,
        date: r.observed_at,
      };
    }).filter(Boolean);
    return res.json({ feed });
  } catch (err) {
    console.error('[GET /api/activity-stats/feed]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/activity-stats/traces — the decision traces: for each rec-linked action, the
// full why → action → outcome chain (the closed loop made visible). Reads ri_decision_traces
// and enriches with the recommendation text + who it was with + the latency.
activityStatsRouter.get('/traces', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 100);
    const supabase = getSupabaseClient();

    let tq = supabase.from('ri_decision_traces')
      .select('id, rec_id, entity_id, action_property, sent_at, outcome, outcome_at')
      .eq('workspace_id', workspaceId).not('rec_id', 'is', null)
      .order('sent_at', { ascending: false }).limit(limit);
    // Personal view: a trace is mine when its send observation is mine. Traces have
    // no owner column, so scope by the member's owned action observations.
    if (req.query.mine === '1' && req.memberUserId) {
      const { data: mySends } = await supabase.from('observations')
        .select('id').eq('workspace_id', workspaceId).eq('owner_user_id', req.memberUserId)
        .in('property', ACTION_PROPS).limit(2000);
      const ids = (mySends ?? []).map((o) => o.id);
      if (!ids.length) return res.json({ traces: [] });
      tq = tq.in('send_observation_id', ids);
    }
    const { data: rows } = await tq;
    const items = rows ?? [];

    const recIds = [...new Set(items.map((t) => t.rec_id).filter(Boolean))];
    const recById = new Map();
    if (recIds.length) {
      const { data: recs } = await supabase.from('ri_recommendations').select('id, text, category').in('id', recIds);
      for (const r of recs ?? []) recById.set(r.id, r);
    }
    const entityIds = [...new Set(items.map((t) => t.entity_id).filter(Boolean))];
    const nameById = new Map();
    if (entityIds.length) {
      const [{ data: cs }, { data: cos }] = await Promise.all([
        supabase.from('contacts').select('id, first_name, last_name, company').in('id', entityIds),
        supabase.from('companies').select('id, name').in('id', entityIds),
      ]);
      for (const c of cs ?? []) nameById.set(c.id, [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || null);
      for (const c of cos ?? []) if (!nameById.has(c.id)) nameById.set(c.id, c.name);
    }

    const traces = items.map((t) => {
      const rec = recById.get(t.rec_id);
      const meta = ACTION_LABELS[t.action_property] ?? { label: 'Action', channel: 'other' };
      const hrs = t.outcome_at ? Math.round(((new Date(t.outcome_at) - new Date(t.sent_at)) / 3_600_000) * 10) / 10 : null;
      return {
        id: t.id,
        why: rec?.text ?? null,
        category: rec?.category ?? null,
        entity_name: nameById.get(t.entity_id) ?? null,
        action_label: meta.label,
        channel: meta.channel,
        sent_at: t.sent_at,
        outcome: t.outcome,            // 'replied' | 'meeting' | null (open)
        outcome_at: t.outcome_at,
        hours_to_outcome: hrs,
      };
    });
    return res.json({ traces });
  } catch (err) {
    console.error('[GET /api/activity-stats/traces]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/activity-stats/rec-effectiveness — how our own recommendations convert,
// by category and channel (the rec-effectiveness trace-learning observation).
activityStatsRouter.get('/rec-effectiveness', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const supabase = getSupabaseClient();
    const { data } = await supabase.from('ri_observations')
      .select('effect, confidence, sample_size, evidence, recommendation_template, updated_at')
      .eq('workspace_id', workspaceId).eq('question_key', 'outbound.rec_effectiveness')
      .order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (!data) return res.json({ effectiveness: null });
    return res.json({
      effectiveness: {
        summary: data.recommendation_template,
        confidence: data.confidence,
        sample_size: data.sample_size,
        overall_rate: data.evidence?.overall_rate ?? null,
        by_category: data.evidence?.by_category ?? [],
        by_channel: data.evidence?.by_channel ?? [],
      },
    });
  } catch (err) {
    console.error('[GET /api/activity-stats/rec-effectiveness]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/activity-stats/objection-coaching — the answer that wins. Learned by reading
// OUR OWN sent replies to objections and tying each response approach to whether the deal
// then advanced (objection.response_coaching observation).
activityStatsRouter.get('/objection-coaching', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const supabase = getSupabaseClient();
    const { data } = await supabase.from('ri_observations')
      .select('effect, confidence, sample_size, evidence, recommendation_template, updated_at')
      .eq('workspace_id', workspaceId).eq('question_key', 'objection.response_coaching')
      .order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (!data) return res.json({ coaching: null });
    return res.json({
      coaching: {
        summary: data.recommendation_template,
        confidence: data.confidence,
        sample_size: data.sample_size,
        best_label: data.evidence?.best_label ?? null,
        best_rate: data.evidence?.best_rate ?? null,
        overall_rate: data.evidence?.overall_rate ?? null,
        by_approach: data.evidence?.by_approach ?? [],
        by_theme: data.evidence?.by_theme ?? [],
      },
    });
  } catch (err) {
    console.error('[GET /api/activity-stats/objection-coaching]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

activityStatsRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const daysParam = req.query.days;
    const days = daysParam === 'all' ? null : Math.min(Math.max(parseInt(daysParam, 10) || 7, 1), 365);

    const supabase = getSupabaseClient();

    let q = supabase
      .from('observations')
      .select('entity_id, property, observed_at')
      .eq('workspace_id', workspaceId)
      .like('property', 'interaction.%');
    if (days != null) q = q.gte('observed_at', new Date(Date.now() - days * DAY).toISOString());
    // Personal view (/connect › Activity): scope to interactions this member owns.
    if (req.query.mine === '1' && req.memberUserId) q = q.eq('owner_user_id', req.memberUserId);

    // Page through — PostgREST caps a response at 1000 rows however big the limit,
    // and a silently truncated count is just a wrong number with confidence.
    const rows = [];
    for (let from = 0; from < 30_000; from += PAGE) {
      const { data, error } = await q.range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data?.length) break;
      rows.push(...data);
      if (data.length < PAGE) break;
    }

    const now = Date.now();
    let conversations = 0, replies = 0, meetingsHeld = 0, meetingsBooked = 0;
    const people = new Set();

    for (const r of rows) {
      const p = String(r.property);
      const isFuture = new Date(r.observed_at).getTime() > now;

      if (MEETING_HELD.test(p)) meetingsHeld++;
      else if (MEETING_BOOKED.test(p) && isFuture) meetingsBooked++;   // still to come

      if (INBOUND.test(p)) { replies++; conversations++; people.add(r.entity_id); }
      else if (OUTBOUND.test(p)) { conversations++; people.add(r.entity_id); }
      else if (MEETING_HELD.test(p)) people.add(r.entity_id);
    }

    return res.json({
      days: days ?? 'all',
      // Messages exchanged either way — the volume of actual contact.
      conversations,
      // The only number that means someone else engaged. Outbound is effort;
      // this is traction.
      replies,
      meetings_held: meetingsHeld,
      meetings_booked: meetingsBooked,
      // Distinct humans you actually interacted with.
      people_touched: people.size,
      // Reply rate is the health metric a GTM operator lives on.
      reply_rate: conversations ? Math.round((replies / conversations) * 1000) / 10 : 0,
    });
  } catch (err) {
    console.error('[GET /api/activity-stats]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/activity-stats/read — what we connected to, and what we have read.
//
// The header of the Activities page, which IS the home page on the API plan. That plan
// has no worklist, no insights and no tasks: the thing it has to say on opening is "here
// is what we plugged into, and here is what came out of it". So: the connected tools, and
// then the counts — accounts analysed, meetings transcribed, email threads read.
//
// These count what REACHED A MODEL, not what the CRM holds. A note is never read and so is
// never counted; a call only counts when it carried a recording. Anything else would tell
// the customer we read 1,400 notes a month when we read four (docs/unit-economics.md).
//
// Email is reported in THREADS READ, counted from the reader's own record (one noema.read row per
// thread, moved to the latest read on a re-read — GET-503). It used to divide every message by an
// a fixed average per thread, which counted mail we skipped or never opened and disagreed with the
// table under it.

activityStatsRouter.get('/read', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const daysParam = req.query.days;
    const days = daysParam === 'all' ? null : Math.min(Math.max(parseInt(daysParam, 10) || 30, 1), 365);
    const since = days ? new Date(Date.now() - days * DAY).toISOString() : null;
    const supabase = getSupabaseClient();

    const countOf = async (build) => {
      let q = supabase.from('observations')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId);
      if (since) q = q.gte('observed_at', since);
      const { count } = await build(q);
      return count ?? 0;
    };

    const [emails, meetings, calls, accounts, connections] = await Promise.all([
      countOf(q => q.eq('property', 'noema.read').eq('source', 'gmail')),
      countOf(q => q.eq('property', 'interaction.meeting_held')),
      countOf(q => q.in('property', ['interaction.call_made', 'interaction.call_received'])),
      supabase.from('entities').select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId).eq('type', 'company').eq('status', 'active')
        .then(r => r.count ?? 0),
      supabase.from('workflow_provider_connections')
        .select('id, provider:workflow_providers(name, display_name, logo_url)')
        .eq('workspace_id', workspaceId)
        .then(r => r.data ?? []),
    ]);

    // One row per tool, deduped: two Gmail connections are one logo, not two.
    const tools = [];
    const seen = new Set();
    for (const c of connections) {
      const name = c?.provider?.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      tools.push({ name, label: c.provider.display_name || name, logo_url: c.provider.logo_url ?? null });
    }

    return res.json({
      days,
      tools,
      read: {
        accounts_analysed: accounts,
        meetings_transcribed: meetings,
        email_threads_read: emails,
        calls_recorded: calls,
      },
    });
  } catch (err) {
    console.error('[GET /api/activity-stats/read]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/activity-stats/conversations — what we read, newest first, with what it cost.
//
// The op log beside this answers "did the machinery run". This answers "what did you read for
// me, and what did it spend" — which is the question the API plan's home page exists for, and
// the one the ledger could not answer because an op is a webhook, not a conversation.
//
// Credits follow the pricing page: an email thread or a recorded call is one, a meeting is one
// per 10 minutes of it. A note is read-free and so is credit-free, and a call with no recording
// never reached a model, so neither appears here. Charging for a row we never opened would be
// the one number on this page nobody could defend.
const CREDITS = { email: 1, call: 1, note: 0 };
const MEETING_MINUTES_PER_CREDIT = 10;

const KIND = {
  'interaction.email_sent':     { kind: 'email',   label: 'Email thread' },
  'interaction.email_received': { kind: 'email',   label: 'Email thread' },
  'interaction.call_made':      { kind: 'call',    label: 'Call' },
  'interaction.call_received':  { kind: 'call',    label: 'Call' },
  'interaction.meeting_held':   { kind: 'meeting', label: 'Meeting' },
  'interaction.note_added':     { kind: 'note',    label: 'Note' },
};

/** Minutes between observed_at and the provider's end_time, when it gave us one. */
function minutesOf(row) {
  const end = row?.end_time;
  if (!end || !row.observed_at) return null;
  const mins = (Date.parse(end) - Date.parse(row.observed_at)) / 60000;
  return Number.isFinite(mins) && mins > 0 && mins < 600 ? mins : null;
}

// Why a thread was not read, in words a person reads (the reader's rule names are for logs).
const SKIP_WORDS = {
  'machine sender': 'Automated',
  'relayed from a source we already hold': 'Automated',
  'role inbox — no attributable subject': 'Shared inbox',
  'outbound only — they never replied': 'No reply yet',
  'no external counterpart': 'Internal',
  'no named counterpart': 'No named contact',
  'nothing to read': 'Nothing to read',
};

/**
 * One row per meeting and per call (GET-744): rows with the same kind, source, time and summary are
 * one conversation (a meeting arrives once per attendee, a HubSpot call once per contact). The copy
 * that was read stands for the group. Order is kept. Pure.
 * @returns {{ r: object, ids: string[] }[]}
 */
export function groupConversations(rows, cited = new Set()) {
  const groups = new Map();
  for (const r of rows ?? []) {
    const k = KIND[r.property] ?? { kind: 'other' };
    const text = String(r.value?.summary ?? r.value?.description ?? r.value?.title ?? '').slice(0, 120);
    const key = k.kind === 'meeting' || k.kind === 'call' ? `${k.kind}|${r.source}|${r.observed_at}|${text}` : `row|${r.id}`;
    const g = groups.get(key);
    if (!g) { groups.set(key, { r, ids: [r.id] }); continue; }
    if (cited.has(r.id) && !g.ids.some((x) => cited.has(x))) g.r = r;
    g.ids.push(r.id);
  }
  return [...groups.values()];
}

/**
 * Run fn over slices of `ids`, `parallel` at a time, results in chunk order (GET-903: these used
 * to run one after another).
 */
async function inChunks(ids, size, fn, parallel = 8) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  const results = new Array(chunks.length);
  let next = 0;
  const worker = async () => { while (next < chunks.length) { const i = next++; results[i] = await fn(chunks[i]); } };
  await Promise.all(Array.from({ length: Math.min(parallel, chunks.length) }, worker));
  return results.flat();
}

// GET-903. `claims.supporting_observation_ids && {…}` has no element statistics to plan on, so
// Postgres guesses 0.5% of all claims per id. Past a handful of ids that guess is most of the
// table and it seq-scans every claim in the database: 5 s a 300-id chunk on prod, 20 s a page.
// Measured through PostgREST on prod, 10 ids still use the GIN index (45–70 ms) and 12 already
// seq-scan (550+ ms), so the chunk is 8, with room under that edge. The guess is a fixed share of
// the table, so the edge does not move as claims grow. No LIMIT on these reads: a LIMIT tips the
// same guess back to a seq scan.
export const CLAIM_CHUNK = 8;
export function claimLookupChunks(ids) {
  const out = [];
  for (let i = 0; i < (ids?.length ?? 0); i += CLAIM_CHUNK) out.push(ids.slice(i, i + CLAIM_CHUNK));
  return out;
}

// Paging (GET-903). The cursor is a point in time: the next page holds what was observed at or
// before it (`incl`), or strictly before it. A page never ends part-way through an instant, so a
// meeting's per-attendee copies (one instant) never straddle two pages.
export function encodeCursor(c) {
  return c ? Buffer.from(JSON.stringify({ ts: c.ts, incl: !!c.incl })).toString('base64url') : null;
}
export function decodeCursor(s) {
  if (!s || typeof s !== 'string') return null;
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (!c || typeof c.ts !== 'string' || Number.isNaN(Date.parse(c.ts))) return null;
    return { ts: c.ts, incl: !!c.incl };
  } catch { return null; }
}

/**
 * Raw rows read newest first, `fetched` of them asked for. A short read is the tail of the
 * window. A full one may have cut an instant in two, so its last instant is left for the next
 * page — unless the whole read is one instant, which is kept and stepped strictly past. Pure.
 */
export function pageRows(rows, fetched) {
  const list = rows ?? [];
  if (list.length < fetched || !list.length) return { rows: list, next: null };
  const last = list[list.length - 1].observed_at;
  const kept = list.filter((r) => r.observed_at !== last);
  if (!kept.length) return { rows: list, next: { ts: last, incl: false } };
  return { rows: kept, next: { ts: last, incl: true } };
}

/** At most `limit` items (newest first), never splitting one instant across pages. Pure. */
export function cutItems(items, limit) {
  if (items.length <= limit) return { items, next: null };
  const edge = items[limit].when;
  const kept = items.filter((i) => String(i.when) > String(edge));
  if (kept.length) return { items: kept, next: { ts: edge, incl: true } };
  return { items: items.filter((i) => String(i.when) >= String(edge)), next: { ts: edge, incl: false } };
}

activityStatsRouter.get('/conversations', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const daysParam = req.query.days;
    const days = daysParam === 'all' ? null : Math.min(Math.max(parseInt(daysParam, 10) || 30, 1), 365);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const cursor = decodeCursor(req.query.cursor);
    const supabase = getSupabaseClient();

    // Messages, not conversations: an email thread arrives as one row per message. Several times
    // the page size is read so that, grouped into threads, the page still holds `limit` rows.
    // Only the three text fields the row shows come back, not the whole value (a meeting's carries
    // its transcript: 0.44 s for a page against 0.09 s without it, GET-903).
    const fetched = Math.min(limit * 5, 1000);
    let q = supabase.from('observations')
      .select('id, entity_id, property, source, observed_at, summary:value->>summary, description:value->>description, title:value->>title, thread_id:raw->>thread_id, end_time:raw->>end_time')
      .eq('workspace_id', workspaceId)
      .in('property', Object.keys(KIND))
      .order('observed_at', { ascending: false })
      .limit(fetched);
    if (days) q = q.gte('observed_at', new Date(Date.now() - days * DAY).toISOString());
    if (cursor) q = cursor.incl ? q.lte('observed_at', cursor.ts) : q.lt('observed_at', cursor.ts);

    const { data: raw, error } = await q;
    if (error) throw error;
    const paged = pageRows(raw ?? [], fetched);
    const rows = paged.rows.map(({ summary, description, title, ...r }) => ({ ...r, value: { summary, description, title } }));
    const ids = rows.map((r) => r.id);

    // ONE ROW PER EMAIL THREAD (GET-503). The page listed every message as an "Email thread" and
    // billed each one a credit, so a three-message thread cost three and an automated notice we
    // never opened cost one. A thread is one credit, and only when it was read.
    const threads = new Map();
    const others = [];
    for (const r of rows ?? []) {
      const k = KIND[r.property] ?? { kind: 'other', label: r.property };
      if (k.kind !== 'email') { others.push(r); continue; }
      const key = r.thread_id ? `tid:${r.thread_id}` : `msg:${r.id}`;
      const t = threads.get(key) ?? { key, threadId: r.thread_id ?? null, messages: [] };
      t.messages.push(r);
      threads.set(key, t);
    }
    const tids = [...threads.values()].map((t) => t.threadId).filter(Boolean);

    // Three reads, side by side (GET-903: they used to wait on each other).
    // FAILED: pipeline_events, where the extractor records a model it could not reach or an answer
    // it could not read. READ (for calls, meetings, and email read before the thread markers):
    // claims citing the conversation. And what the reader did with each thread: its read marker
    // (what came out, when) or its skip marker (the rule that passed it over), written by
    // workers/emailThreadsDaily.mjs.
    const [failedRows, claimRows, markers] = ids.length ? await Promise.all([
      supabase.from('pipeline_events')
        .select('kind, detail')
        .eq('workspace_id', workspaceId)
        .in('kind', ['unavailable', 'unparseable'])
        .gte('occurred_at', new Date(Date.now() - (days ?? 365) * DAY).toISOString())
        .limit(500)
        .then((r) => r.data ?? []),
      inChunks(ids, CLAIM_CHUNK, (chunk) => supabase.from('claims')
        .select('supporting_observation_ids')
        .eq('workspace_id', workspaceId)
        .overlaps('supporting_observation_ids', chunk)
        .then((r) => { if (r.error) throw r.error; return r.data ?? []; }), 16),
      tids.length ? inChunks(
        tids.flatMap((id) => [`gmail_${id}`, `gmail_skip_${id}`]), 300,
        (chunk) => supabase.from('observations').select('property, external_id, value, observed_at')
          .eq('workspace_id', workspaceId).eq('source', 'gmail').in('property', ['noema.read', 'noema.skip'])
          .in('external_id', chunk).then((r) => r.data ?? []),
        4,
      ) : [],
    ]) : [[], [], []];
    const failed = new Set(failedRows.map((e) => e?.detail?.activity_id).filter(Boolean));
    const cited = new Set(claimRows.flatMap((c) => c.supporting_observation_ids ?? []));

    const readMark = new Map(), skipMark = new Map();
    for (const m of markers) {
      if (m.property === 'noema.read') readMark.set(m.external_id.slice('gmail_'.length), m);
      else skipMark.set(m.external_id.slice('gmail_skip_'.length), m);
    }

    const emailItems = [...threads.values()].map((t) => {
      const latest = t.messages[0];          // rows are newest first
      const readM = t.threadId ? readMark.get(t.threadId) : null;
      const skipM = t.threadId ? skipMark.get(t.threadId) : null;
      const anyCited = t.messages.some((m) => cited.has(m.id));
      const anyFailed = t.messages.some((m) => failed.has(m.id));
      const found = readM ? (readM.value?.claims ?? 0) + (readM.value?.commitments ?? 0) + (readM.value?.insights ?? 0) : 0;
      // A read marker older than the newest message means a reply arrived since: it waits for
      // the next run, which reads the thread again.
      const stale = readM && Date.parse(readM.value?.read_at ?? readM.observed_at) < Date.parse(latest.observed_at);
      let status, reason = null;
      if (readM && !stale) status = found > 0 ? 'read' : 'nothing_new';
      else if (anyFailed) status = 'failed';
      else if (!readM && anyCited) status = 'read';
      else if (skipM && !stale) { status = 'skipped'; reason = SKIP_WORDS[skipM.value?.reason] ?? 'Skipped'; }
      else status = 'waiting';
      return {
        id: t.key,
        kind: 'email',
        label: 'Email thread',
        source: latest.source,
        when: latest.observed_at,
        messages: t.messages.length,
        read_at: readM ? (readM.value?.read_at ?? readM.observed_at) : null,
        minutes: null,
        estimated: false,
        // One credit a thread, and only for a thread that was actually read.
        credits: status === 'read' || status === 'nothing_new' ? 1 : 0,
        status,
        reason,
        summary: (latest.value?.summary ?? latest.value?.description ?? '').toString().slice(0, 160) || null,
      };
    });

    // ONE ROW PER MEETING AND PER CALL (GET-744). A meeting arrives once per attendee (a Fellow
    // call with five people is five rows) and a HubSpot call once per associated contact. The same
    // source, time and summary is one conversation: one row, read if any copy was read, its credits once.
    const groups = groupConversations(others, cited);
    const otherItems = groups.map(({ r, ids }) => {
      const anyRead = ids.some((x) => cited.has(x));
      const anyFailed = ids.some((x) => failed.has(x));
      const k = KIND[r.property] ?? { kind: 'other', label: r.property };
      const mins = k.kind === 'meeting' ? minutesOf(r) : null;
      const status = anyRead ? 'read' : anyFailed ? 'failed' : null;
      const credits = status !== 'read' ? 0 : k.kind === 'meeting'
        ? Math.max(1, Math.ceil((mins ?? 30) / MEETING_MINUTES_PER_CREDIT))
        : (CREDITS[k.kind] ?? 0);
      return {
        id: r.id,
        kind: k.kind,
        label: k.label,
        source: r.source,
        when: r.observed_at,
        messages: null,
        read_at: null,
        minutes: mins ? Math.round(mins) : null,
        // A meeting with no recorded length bills at the measured median, 30 minutes, and says
        // so rather than quietly charging three credits as if it knew.
        estimated: k.kind === 'meeting' && mins == null,
        credits,
        status,
        reason: null,
        summary: (r.value?.summary ?? r.value?.description ?? '').toString().slice(0, 160) || null,
        // How many rows this one stands for (people on the meeting, contacts on the call).
        copies: ids.length,
      };
    });

    const sorted = [...emailItems, ...otherItems]
      .sort((a, b) => String(b.when).localeCompare(String(a.when)));
    const page = cutItems(sorted, limit);

    // The next page starts where this one stopped (GET-903). An email thread whose older messages
    // fall past the cut can show again there; the page keeps the first, newest, copy of an id.
    return res.json({ days, items: page.items, next_cursor: encodeCursor(page.next ?? paged.next) });
  } catch (err) {
    console.error('[GET /api/activity-stats/conversations]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
