// Record events (GET-559) — something happened on an account, pushed to the workspace's own
// stack (n8n, Clay, their agent) with the record attached.
//
// One door: every detector calls emitEvent. It finds who listens, builds the record ONCE, and
// writes one outbound_events row per subscription; the trigger delivery worker signs, sends and
// retries from there. A bare "health changed" is what any CRM can send. What we send is the
// identity-resolved account, its people, the deal and the evidence behind it, with source and
// confidence, so the receiver can act without calling back.
//
// THE PAYLOAD READS AS THE WHOLE TEAM (teamReadContext). A webhook is a shared destination, so it
// carries only what every member may read: structured claims and team-readable facts, never
// something derived from one person's private mail.
import crypto from 'node:crypto';
import { getAccountRecord } from '../db/claims.js';
import { teamReadContext } from '../db/readContext.js';
import { subscribersFor } from '../db/triggers.js';
import { loadAutomationExtension } from './automationExtension.mjs';

/** Bump when the envelope changes shape. Receivers can branch on it. */
export const EVENT_API_VERSION = '2026-10-01';

// An event older than this is history, not news: a backfill or a re-import replaying the past
// must not page anybody. Deal events pass a longer window (the ledger learns of a close late).
const DEFAULT_MAX_AGE_HOURS = 48;
// A new subscription hears about what happened from a week before it existed, not the
// workspace's whole past.
const SUBSCRIBE_GRACE_MS = 7 * 86_400_000;

const MAX_PEOPLE = 10;
const MAX_FACTS = 8;
const MAX_CLAIMS = 15;
// Account claims worth sending, in this order when present. note.* and action_item.* are facts
// and commitments, sent as evidence; the rest are internal bookkeeping.
const KEY_CLAIMS = [
  'name', 'domain', 'industry', 'employee_count', 'country', 'pipeline_stage', 'deal_value',
  'deal_health', 'owner_name', 'owner_email', 'competitors', 'tech_stack', 'next_step',
  'last_contacted_at', 'champion',
];
const DEAL_PROPS = ['name', 'stage', 'status', 'value', 'currency', 'close_date', 'owner_name', 'owner_email'];

const unwrap = (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? v.value : v);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

async function accountRow(supabase, workspaceId, entityId) {
  const { data } = await supabase.from('entity_list_rows').select('*')
    .eq('workspace_id', workspaceId).eq('entity_id', entityId).maybeSingle();
  return data ?? null;
}

/** The account a person works at, when the event named only the person. */
async function accountOf(supabase, workspaceId, personId) {
  const row = await accountRow(supabase, workspaceId, personId);
  return row?.kind === 'person' ? row.company_id ?? null : row?.kind === 'account' ? personId : null;
}

async function icpTier(supabase, workspaceId, entityId) {
  const { data } = await supabase.from('predictions').select('predicted_value')
    .eq('workspace_id', workspaceId).eq('kind', 'icp_fit').eq('entity_id', entityId)
    .order('predicted_at', { ascending: false }).limit(1).maybeSingle();
  const v = data?.predicted_value ?? null;
  return v ? { score: v.score ?? null, tier: v.tier ?? null } : null;
}

async function peopleAt(supabase, workspaceId, accountId) {
  const { data } = await supabase.from('entity_list_rows')
    .select('entity_id, name, email, job_title, stage, last_activity_at')
    .eq('workspace_id', workspaceId).eq('kind', 'person').eq('company_id', accountId)
    .order('last_activity_at', { ascending: false, nullsFirst: false }).limit(MAX_PEOPLE);
  return data ?? [];
}

/**
 * The deal the event is about: the one named, else the account's open deal closing soonest,
 * else its latest. Deals are entities that `belongs_to` the account.
 */
async function dealFor(supabase, workspaceId, accountId, dealId) {
  let ids = dealId ? [dealId] : [];
  if (!ids.length && accountId) {
    const { data: rels } = await supabase.from('relationships').select('from_entity_id')
      .eq('workspace_id', workspaceId).eq('type', 'belongs_to').eq('to_entity_id', accountId)
      .is('valid_to', null).limit(50);
    ids = [...new Set((rels ?? []).map(r => r.from_entity_id))];
  }
  if (!ids.length) return { deal: null, count: 0 };
  const { data: claims } = await supabase.from('claims').select('entity_id, property, value')
    .eq('workspace_id', workspaceId).in('entity_id', ids).in('property', DEAL_PROPS).is('invalid_at', null);
  const byId = new Map(ids.map(id => [id, { entity_id: id }]));
  for (const c of claims ?? []) {
    const d = byId.get(c.entity_id);
    if (d) d[c.property] = unwrap(c.value);
  }
  const deals = [...byId.values()].filter(d => Object.keys(d).length > 1 || dealId);
  const closed = (d) => /won|lost/i.test(String(d.status ?? d.stage ?? ''));
  const by = (a, b) => String(a.close_date ?? '9999').localeCompare(String(b.close_date ?? '9999'));
  const pick = dealId ? deals[0]
    : deals.filter(d => !closed(d)).sort(by)[0] ?? deals.sort(by).reverse()[0];
  if (!pick) return { deal: null, count: deals.length };
  const amount = Number(pick.value);
  return {
    deal: clean({
      entity_id: pick.entity_id,
      name: pick.name ?? null,
      stage: pick.stage ?? null,
      status: pick.status ?? null,
      amount: Number.isFinite(amount) && pick.value != null ? amount : null,
      currency: pick.currency ?? null,
      close_date: pick.close_date ?? null,
      owner: pick.owner_name || pick.owner_email ? { name: pick.owner_name ?? null, email: pick.owner_email ?? null } : null,
    }),
    count: deals.length,
  };
}

/**
 * The record that rides on every event: account, people, deal and evidence. Read as the team.
 * Exported for the test send, which shows a subscriber the shape against one of their accounts.
 */
export async function buildEventRecord(supabase, workspaceId, { accountId = null, personId = null, dealId = null } = {}) {
  const account = accountId ?? (personId ? await accountOf(supabase, workspaceId, personId) : null);
  const [row, icp, record, people, { deal, count }] = await Promise.all([
    account ? accountRow(supabase, workspaceId, account) : null,
    account ? icpTier(supabase, workspaceId, account) : null,
    account ? getAccountRecord(supabase, workspaceId, account, teamReadContext(workspaceId)).catch(() => null) : null,
    account ? peopleAt(supabase, workspaceId, account) : [],
    dealFor(supabase, workspaceId, account, dealId),
  ]);

  // The person the event is about goes first, even when they are not among the ten most active.
  let peopleOut = people.map(p => clean({
    entity_id: p.entity_id, name: p.name ?? null, email: p.email ?? null, title: p.job_title ?? null, stage: p.stage ?? null,
  }));
  if (personId && personId !== account) {
    const i = peopleOut.findIndex(p => p.entity_id === personId);
    if (i > 0) peopleOut.unshift(...peopleOut.splice(i, 1));
    if (i < 0) {
      const p = await accountRow(supabase, workspaceId, personId);
      if (p) peopleOut = [clean({ entity_id: personId, name: p.name ?? null, email: p.email ?? null, title: p.job_title ?? null, stage: p.stage ?? null }), ...peopleOut].slice(0, MAX_PEOPLE);
    }
  }

  const claims = record?.claims ?? {};
  const keyClaims = KEY_CLAIMS.filter(k => claims[k]).slice(0, MAX_CLAIMS).map(k => {
    const c = claims[k];
    return clean({
      property: k, value: unwrap(c.value), confidence: c.confidence ?? null, freshness: c.freshness ?? null,
      observations: c.observation_count ?? null, last_observed_at: c.last_observed_at ?? null,
    });
  });
  const facts = (record?.facts ?? []).slice(0, MAX_FACTS).map(f => clean({
    fact: f.content, category: f.category ?? null, quote: f.quote, speaker: f.speaker,
    source: f.source ?? null, source_ref: f.source_ref, observed_at: f.date ?? null,
  }));

  return {
    account: account ? clean({
      entity_id: account,
      name: row?.name ?? record?.name ?? null,
      domain: row?.domain ?? null,
      industry: row?.industry ?? null,
      country: row?.country ?? null,
      stage: row?.stage ?? null,
      icp: icp ?? (row?.icp_score != null ? { score: row.icp_score, tier: null } : null),
      health: row?.deal_health ?? null,
      open_deals: row?.open_deals ?? null,
      pipeline_value: row?.pipeline_value != null ? Number(row.pipeline_value) : null,
      won_value: row?.won_value != null ? Number(row.won_value) : null,
      people_count: row?.people_count ?? null,
      last_activity_at: row?.last_activity_at ?? null,
      api_url: `/v2/accounts/${account}`,
    }) : null,
    people: peopleOut,
    deal,
    deals_count: count,
    evidence: { claims: keyClaims, facts },
  };
}

/** The signed body every record event carries. */
export function eventEnvelope({ type, workspaceId, occurredAt, record, data = {} }) {
  return {
    id: crypto.randomUUID(),
    type,
    api_version: EVENT_API_VERSION,
    occurred_at: occurredAt,
    workspace_id: workspaceId,
    ...record,
    data,
  };
}

/**
 * Something happened. Builds the record once and queues one delivery per subscription that
 * listens for `type`. Best-effort: a detector must never fail because the event system is
 * unhealthy, so this swallows its own errors and returns how many deliveries it queued.
 *
 * `dedupeKey` is the event's identity — the same key never queues twice for a subscription
 * (outbound_events' unique external_id), so a re-sync or a second detector is a no-op.
 */
export async function emitEvent(supabase, {
  workspaceId, type, accountId = null, personId = null, dealId = null,
  occurredAt = null, data = {}, internalData = null, dedupeKey, maxAgeHours = DEFAULT_MAX_AGE_HOURS,
}) {
  try {
    if (!workspaceId || !type || !dedupeKey) return 0;
    const at = occurredAt ? new Date(occurredAt) : new Date();
    if (Number.isNaN(at.getTime())) return 0;
    if (Date.now() - at.getTime() > maxAgeHours * 3_600_000) return 0;

    // The automation engine's extension hears every event first (GET-910): `internalData` rides along
    // for it only, never in a webhook's payload.
    const ext = await loadAutomationExtension();
    if (ext?.onEvent) await Promise.resolve(ext.onEvent(supabase,{workspaceId,type,accountId,occurredAt:at.toISOString(),data:{...data,...(internalData??{})},dedupeKey})).catch(err=>console.warn('[events] extension',err.message));
    const externalId = `${type}:${dedupeKey}`;
    let subs = (await subscribersFor(supabase, workspaceId, type))
      .filter(s => at.getTime() >= new Date(s.created_at).getTime() - SUBSCRIBE_GRACE_MS);
    if (!subs.length) return 0;
    // ALREADY SENT IS CHECKED BEFORE THE RECORD IS BUILT. The hourly deal pass re-reads 45 days
    // of closes; without this every one of them would rebuild its record every hour only for
    // the unique index to throw it away.
    const { data: sent } = await supabase.from('outbound_events').select('subscription_id')
      .eq('workspace_id', workspaceId).eq('external_id', externalId)
      .in('subscription_id', subs.map(s => s.id));
    const done = new Set((sent ?? []).map(r => r.subscription_id));
    subs = subs.filter(s => !done.has(s.id));
    if (!subs.length) return 0;

    const record = await buildEventRecord(supabase, workspaceId, { accountId, personId, dealId });
    const payload = eventEnvelope({ type, workspaceId, occurredAt: at.toISOString(), record, data });
    const rows = subs.map(s => ({
      workspace_id: workspaceId,
      subscription_id: s.id,
      entity_id: record.account?.entity_id ?? personId ?? null,
      event_type: type,
      payload,
      occurred_at: at.toISOString(),
      external_id: externalId,
    }));
    const { error } = await supabase.from('outbound_events')
      .upsert(rows, { onConflict: 'workspace_id,subscription_id,external_id', ignoreDuplicates: true });
    if (error) { console.warn(`[events] ${type} enqueue failed:`, error.message); return 0; }
    return rows.length;
  } catch (err) {
    console.warn(`[events] ${type} failed:`, err?.message ?? err);
    return 0;
  }
}
