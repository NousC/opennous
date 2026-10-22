// The deals on an account, and one deal in full (GET-262).
//
// A deal in the CRM is a `type: 'deal'` entity: `belongs_to` its company, people `stakeholder_of`
// it, stage moves as dated observations, and (since #110) the calls and emails a rep filed to it
// in `observation_deals`. None of that had a reader a person could open. The account page showed
// one number for the whole company, so an account with a renewal and an expansion open at once
// read as a single blended deal.
//
// Health is the SAME computeDealHealth the account uses, fed a deal-sized slice of the account:
// the people on the deal, the facts they voiced, and their conversations plus the ones filed to
// the deal. The account is loaded once and sliced per deal, so listing ten deals is not ten
// copies of the account page's reads.
//
// An account with no CRM deal still "has a deal": the one its own stage, value and health
// describe. That implied deal is returned with id 'account' so every account has something to
// open, and it never pretends to be a CRM record.

import {
  listAccountNotes, listActivities, computeDealHealth, loadHealthHistory, loadNextSteps,
  loadDealCandidates, getDealObservationIds, dealStageHops, accountStage, TERMINAL_STAGES,
  getRelationshipOwners, getWorkspaceMemberProfiles, accountOwnerIds,
  readPrimaryPipelineRef, CLOSE_RECORD_PROPERTY,
} from '@nous/core';
import { intelTopicsFor } from './intelTopics.mjs';
import { viewerReadContext } from './messagePrivacy.mjs';

export const ACCOUNT_DEAL_ID = 'account';
/** The name of an account's own deal — the one it has before any CRM deal exists. */
export const impliedDealName = (companyName) => `${companyName || 'Account'} deal`;
const HISTORY_DAYS = 1095;
const MAX_DEALS = 60;

const nameOf = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Unknown';

// ─── Which pipeline a deal is in ─────────────────────────────────────────────
//
// A CRM deal carries its pipeline as two state observations the sync writes side by side:
// `pipeline`, the display name (reps rename those, and they arrive with stray whitespace), and
// `pipeline_id`, the CRM's own id (HubSpot's primary is the literal `default`). The id is the
// key a reader compares; the name is what a person sees. Deals synced before the id was written
// lack it until the backfill runs, so it is optional here, and a missing id never means "the
// primary one": it means we don't know.
//
// A workspace has more than one pipeline, and the CRM's default pipeline IS the workspace: its
// stages are the ladder. Deals from the others still belong on every list, each saying which
// pipeline it is in, so an expansion never reads as a new-business deal at a stage the ladder
// doesn't name.

const PIPELINE_PROPS = ['pipeline', 'pipeline_id'];
const PIPELINE_BATCH = 100;      // deals per observations read; a batch's rows stay well under the 1000-row page
const PIPELINE_CONCURRENCY = 4;
const PAGE = 1000;

const unwrapValue = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
/** A name or id as a person (or a comparison) should read it: trimmed, null when nothing is left. */
const cleanText = (v) => {
  const u = unwrapValue(v);
  if (u == null) return null;
  const t = String(u).trim();
  return t || null;
};

/**
 * The pipeline of each deal, from its latest `pipeline` / `pipeline_id` observations (newest
 * observed_at wins, so a deal moved between pipelines reads where it is now). One read per 100
 * deals, paged only while a deal in the batch is still unanswered, so a workspace of thousands
 * of deals is not thousands of round trips.
 * @returns Map<dealId, { pipeline: string|null, pipeline_id: string|null }>
 */
export async function loadDealPipelines(supabase, workspaceId, dealIds) {
  const ids = [...new Set((dealIds || []).filter(id => id && id !== ACCOUNT_DEAL_ID))];
  const out = new Map(ids.map(id => [id, { pipeline: null, pipeline_id: null }]));
  if (!ids.length) return out;

  const batches = [];
  for (let i = 0; i < ids.length; i += PIPELINE_BATCH) batches.push(ids.slice(i, i + PIPELINE_BATCH));

  const readBatch = async (batch) => {
    // Per deal, which properties have answered. Newest first, so the first row seen for a
    // property is the current value, whatever it is.
    const answered = new Map(batch.map(id => [id, new Set()]));
    let complete = 0;
    for (let from = 0; complete < batch.length; from += PAGE) {
      const { data, error } = await supabase.from('observations').select('entity_id, property, value')
        .eq('workspace_id', workspaceId).in('entity_id', batch).in('property', PIPELINE_PROPS)
        // id breaks the tie: a sync writes both rows for one deal in a single statement, so they
        // share observed_at AND created_at, and an untied window can drop one across a page edge.
        .order('observed_at', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: false })
        .range(from, from + PAGE - 1);
      // Two optional display fields are never worth failing a deal list for. Unanswered deals keep
      // their null pipeline, which every reader already treats as "unknown".
      if (error) { console.warn('[loadDealPipelines]', error.message); break; }
      for (const r of data ?? []) {
        const seen = answered.get(r.entity_id);
        if (!seen || seen.has(r.property)) continue;
        seen.add(r.property);
        out.get(r.entity_id)[r.property] = cleanText(r.value);
        if (seen.size === PIPELINE_PROPS.length) complete++;
      }
      if (!data || data.length < PAGE) break;
    }
  };
  for (let i = 0; i < batches.length; i += PIPELINE_CONCURRENCY) {
    await Promise.all(batches.slice(i, i + PIPELINE_CONCURRENCY).map(readBatch));
  }
  return out;
}

/** The same deals, each with its `pipeline` (trimmed name or null) and `pipeline_id` (or null). */
export async function withDealPipelines(supabase, workspaceId, deals) {
  const byId = await loadDealPipelines(supabase, workspaceId, deals.map(d => d.id));
  return deals.map(d => ({ ...d, pipeline: byId.get(d.id)?.pipeline ?? null, pipeline_id: byId.get(d.id)?.pipeline_id ?? null }));
}

// Which pipeline is "the pipeline" here. One definition for every reader, in core, so the deal
// list and the revenue report can never name different primary pipelines for one workspace.
export { readPrimaryPipelineRef };

/** Everything the account's deals are sliced from. One set of reads per request. */
export async function loadAccountDealContext(supabase, req, workspaceId, company) {
  const { data: contactRows } = await supabase.from('contacts')
    .select('id, first_name, last_name, email, job_title, seniority, pipeline_stage, deal_health_score, deal_value, photo_url, last_activity_at')
    .eq('workspace_id', workspaceId).eq('company_id', company.id)
    .order('deal_health_score', { ascending: false, nullsLast: true });
  const contacts = contactRows || [];
  const contactIds = contacts.map(c => c.id);
  const ctx = viewerReadContext(req, workspaceId);
  const since = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString();
  const [notes, activity, nextSteps] = await Promise.all([
    listAccountNotes(supabase, workspaceId, company.id, contactIds, {}, ctx),
    // The company entity too: an engagement HubSpot tied to no contact lands on the account.
    listActivities(supabase, { contactIds: [company.id, ...contactIds], since, limit: 400, workspaceId }, ctx),
    loadNextSteps(supabase, workspaceId, [company.id, ...contactIds]),
  ]);
  const byId = new Map(contacts.map(c => [c.id, c]));
  for (const a of activity) a.contactName = byId.get(a.contact_id) ? nameOf(byId.get(a.contact_id)) : null;
  // The account's owners (the same reading /detail shows), and every member's profile for a CRM
  // deal owner who is also on the team.
  const [ownerMap, profiles] = await Promise.all([
    getRelationshipOwners(supabase, workspaceId, [company.id, ...contactIds]),
    getWorkspaceMemberProfiles(supabase, workspaceId),
  ]);
  const owners = accountOwnerIds([ownerMap.get(company.id), ...contactIds.map(id => ownerMap.get(id))])
    .map(uid => ({ user_id: uid, name: profiles.get(uid)?.name ?? null, avatar: profiles.get(uid)?.avatar ?? null }))
    .filter(o => o.name);
  return { company, contacts, byId, notes: notes || [], activity, nextSteps, owners, profiles };
}

function person(c) {
  return { id: c.id, name: nameOf(c), title: c.job_title || null, photo_url: c.photo_url || null, last_activity_at: c.last_activity_at || null };
}

/** The account's own deal: its stage, its value, all its people. */
function impliedDeal(acc) {
  const value = acc.contacts.reduce((best, c) => (c.deal_value != null && (best == null || c.deal_value > best) ? c.deal_value : best), acc.company.deal_value ?? null);
  // The account's stage by the one rule the board and the account page read (GET-263).
  const stage = accountStage(acc.contacts.map(c => c.pipeline_stage)) || 'identified';
  const status = stage === 'closed_won' ? 'won' : TERMINAL_STAGES.includes(stage) ? 'lost' : 'open';
  return {
    // Named for its account, so it reads as a deal in a list of deals (GET-268).
    id: ACCOUNT_DEAL_ID, implied: true, name: impliedDealName(acc.company.name), stage, status, value, currency: null,
    close_date: null, opened_date: null, pipeline: null, pipeline_id: null, owner_name: acc.owners[0]?.name ?? null, owner_email: null,
    owners: acc.owners,
    roster: acc.contacts.map(person), roster_known: acc.contacts.length > 0, last_stage_change_at: null,
  };
}

/**
 * A deal's slice of the account, and its health.
 *
 * The people are the deal's roster when the CRM told us one; otherwise the whole account (said
 * so via roster_known, never silently). A person at a paying customer carries pipeline_stage
 * 'client', which computeDealHealth reads as WON — right for the account, wrong for an open
 * expansion on it — so the deal's own status replaces the people's stage here.
 */
function sliceForDeal(acc, deal, attributedIds) {
  const rosterIds = new Set((deal.roster || []).map(r => (typeof r === 'string' ? r : r.id)));
  const scoped = rosterIds.size > 0 && !deal.implied;
  const inScope = (id) => !scoped || rosterIds.has(id);
  const people = acc.contacts.filter(c => inScope(c.id));
  // A claim is the deal's when its source observation is (GET-404) — the rule CLAUDE.md states
  // and this reader did not apply. It sliced intel by roster PERSON, so two deals on one account
  // with the same people showed identical intel, and "which deal was that objection about" was
  // unanswerable from the page. Now: a claim whose evidence is attributed to this deal (mirrored
  // from the CRM, or filed by a rep through the CRM agent) is `filed_to_deal`; the roster's other
  // claims stay on the list, marked as the account's, the way the Tasks tab already splits them.
  // A deal with nothing attributed yet falls back to the roster alone — said so via the flag,
  // never silently.
  const notes = scoped
    ? acc.notes
        .filter(n => rosterIds.has(n.entity_id) || rosterIds.has(n.metadata?.voiced_by_contact_id) || claimFiledToDeal(n, attributedIds))
        .map(n => ({ ...n, filed_to_deal: claimFiledToDeal(n, attributedIds) }))
    : acc.notes.map(n => ({ ...n, filed_to_deal: false }));
  // The implied deal IS the account, so it reads exactly what the account's Deal Health card
  // reads (its people's latest 100) — two numbers for one account would be a bug on screen.
  const activity = deal.implied
    ? acc.activity.filter(a => a.contact_id !== acc.company.id).slice(0, 100)
    : acc.activity.filter(a => attributedIds.has(a.id) || (a.contact_id !== acc.company.id && inScope(a.contact_id)));
  const dealStage = deal.status === 'won' ? 'won' : null;
  const stakeholders = people.map(c => ({
    id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || null, title: c.job_title, seniority: c.seniority, last_activity_at: c.last_activity_at,
    pipeline_stage: deal.implied ? c.pipeline_stage : dealStage,
    signal_count: activity.filter(a => a.contact_id === c.id).length,
  }));
  // An open or lost deal is not won because the account once won something (a customer's
  // renewal-lost read 90 "Won" off the account's own deal_won activity).
  const healthActs = deal.status !== 'won' && !deal.implied
    ? activity.filter(a => !/won|closed[_\s-]?won/i.test(a.activity_type || ''))
    : activity;
  const nextSteps = acc.nextSteps === undefined ? undefined
    : acc.nextSteps.filter(x => x.entity_id === acc.company.id || inScope(x.entity_id));
  const health = computeDealHealth({ company: acc.company, notes, activity: healthActs, stakeholders, nextSteps, closeDate: deal.close_date ?? null });
  if (deal.status === 'lost') health.band = 'Lost';
  return { people, notes, activity, health };
}

/**
 * Whether a claim's evidence is attributed to the deal. The extractor writes the source
 * observation into `supporting_observation_ids`; older rows carry it only in metadata
 * (`source_activity_id`, `source_observation_ids`). Any of them in `observation_deals` for this
 * deal makes the claim the deal's.
 */
export function claimFiledToDeal(note, attributedIds) {
  if (!attributedIds?.size) return false;
  const m = note?.metadata ?? {};
  const ids = [
    ...(Array.isArray(note?.supporting_observation_ids) ? note.supporting_observation_ids : []),
    ...(Array.isArray(m.source_observation_ids) ? m.source_observation_ids : []),
    ...(m.source_activity_id ? [m.source_activity_id] : []),
  ];
  return ids.some(id => attributedIds.has(String(id)));
}

async function attributedFor(supabase, workspaceId, dealId) {
  if (dealId === ACCOUNT_DEAL_ID) return new Set();
  const rows = await getDealObservationIds(supabase, workspaceId, dealId).catch(() => []);
  return new Set(rows.map(r => r.observation_id));
}

function daysInStage(deal, now = Date.now()) {
  const at = deal.last_stage_change_at ? Date.parse(deal.last_stage_change_at) : NaN;
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 86400000)) : null;
}

const STATUS_ORDER = { open: 0, won: 1, lost: 2 };

/** A CRM deal's owner, as the same shape the account's owners use (avatar when they're a teammate). */
function crmDealOwners(acc, ownerName, ownerEmail) {
  const name = ownerName || ownerEmail || null;
  if (!name) return [];
  const teammate = [...acc.profiles.entries()].find(([, p]) => p.name && ownerName && p.name.toLowerCase() === String(ownerName).toLowerCase());
  return [{ user_id: teammate?.[0] ?? null, name, avatar: teammate?.[1]?.avatar ?? null }];
}

/** GET /api/companies/:id/deals — open first, then won, then lost; newest close first within. */
export async function listAccountDeals(supabase, req, workspaceId, company) {
  const acc = await loadAccountDealContext(supabase, req, workspaceId, company);
  const [allCandidates, primary_pipeline_ref] = await Promise.all([
    loadDealCandidates(supabase, workspaceId, company.id),
    readPrimaryPipelineRef(supabase, workspaceId),
  ]);
  const candidates = allCandidates.slice(0, MAX_DEALS);

  if (!candidates.length) {
    const deal = impliedDeal(acc);
    const { health } = sliceForDeal(acc, deal, new Set());
    return { deals: [{ ...deal, roster: deal.roster.slice(0, 8), days_in_stage: null, health: { score: health.score, band: health.band } }], implied: true, primary_pipeline_ref };
  }

  // The CRM's owner name per deal (the candidates carry only the email), and the pipeline each
  // deal is in (the candidates carry neither). One read each for the whole list.
  const dealIds = candidates.map(c => c.dealEntityId);
  const [{ data: ownerRows }, pipelines] = await Promise.all([
    supabase.from('claims').select('entity_id, value')
      .eq('workspace_id', workspaceId).eq('property', 'owner_name').is('invalid_at', null)
      .in('entity_id', dealIds),
    loadDealPipelines(supabase, workspaceId, dealIds),
  ]);
  const ownerNameOf = new Map((ownerRows || []).map(r => [r.entity_id, r.value && typeof r.value === 'object' && 'value' in r.value ? r.value.value : r.value]));

  const deals = await Promise.all(candidates.map(async (c) => {
    const pl = pipelines.get(c.dealEntityId);
    const deal = {
      id: c.dealEntityId, implied: false, name: c.name || 'Untitled deal', stage: c.stage, status: c.status || 'open',
      value: c.value, close_date: c.closeDate, owner_email: c.ownerEmail, roster: c.roster,
      roster_known: c.roster.length > 0, last_stage_change_at: c.lastStageChangeAt, products: c.products,
      pipeline: pl?.pipeline ?? null, pipeline_id: pl?.pipeline_id ?? null,
      owners: crmDealOwners(acc, ownerNameOf.get(c.dealEntityId) ?? null, c.ownerEmail),
    };
    const { people, health } = sliceForDeal(acc, deal, await attributedFor(supabase, workspaceId, c.dealEntityId));
    return {
      ...deal,
      roster: people.slice(0, 8).map(person),
      roster_count: deal.roster_known ? people.length : 0,
      days_in_stage: daysInStage(deal),
      health: { score: health.score, band: health.band },
    };
  }));
  deals.sort((a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3)
    || String(b.close_date || '').localeCompare(String(a.close_date || '')));
  return { deals, implied: false, primary_pipeline_ref };
}

const accountTopics = (supabase, workspaceId, acc) =>
  intelTopicsFor(supabase, workspaceId, acc.company.id, acc.notes,
    () => listAccountNotes(supabase, workspaceId, acc.company.id, acc.contacts.map(c => c.id))).catch(() => null);

/** GET /api/companies/:id/deals/:dealId — one deal in full, or null when it isn't on this account. */
export async function getAccountDeal(supabase, req, workspaceId, company, dealId) {
  const acc = await loadAccountDealContext(supabase, req, workspaceId, company);

  if (dealId === ACCOUNT_DEAL_ID) {
    const deal = impliedDeal(acc);
    const { activity, notes, health } = sliceForDeal(acc, deal, new Set());
    health.history = await loadHealthHistory(supabase, workspaceId, company.id).catch(() => []);
    // The account's own deal is in no CRM pipeline, so there is nothing to compare it against.
    return { deal, account: accountRef(company), people: acc.contacts.map(person), stages: [], line_items: [], activity: activity.slice(0, 150), notes, intel_topics: await accountTopics(supabase, workspaceId, acc), health, attributed_count: 0, primary_pipeline_ref: null };
  }

  const candidates = await loadDealCandidates(supabase, workspaceId, company.id);
  const c = candidates.find(x => x.dealEntityId === dealId);
  if (!c) return null;

  const [{ data: claimRows }, pipelines, primary_pipeline_ref] = await Promise.all([
    supabase.from('claims').select('property, value')
      .eq('workspace_id', workspaceId).eq('entity_id', dealId).is('invalid_at', null)
      // `deal.close_record`: why it closed, written once at close by the worker (GET-405).
      .in('property', ['currency', 'opened_date', 'owner_name', 'pipeline', CLOSE_RECORD_PROPERTY]),
    // The same reading the lists use, so a deal never names one pipeline in a list and another
    // on its own page. The claim is only the fallback for a deal with no observation to read.
    loadDealPipelines(supabase, workspaceId, [dealId]),
    readPrimaryPipelineRef(supabase, workspaceId),
  ]);
  const extra = Object.fromEntries((claimRows || []).map(r => [r.property, r.value && typeof r.value === 'object' && 'value' in r.value ? r.value.value : r.value]));
  // The record is stored as the value itself (an object with `events`), not wrapped in {value}.
  const closeRow = (claimRows || []).find(r => r.property === CLOSE_RECORD_PROPERTY);
  const close_record = closeRow?.value && typeof closeRow.value === 'object' && Array.isArray(closeRow.value.events) ? closeRow.value : null;
  const pl = pipelines.get(dealId);

  const deal = {
    id: dealId, implied: false, name: c.name || 'Untitled deal', stage: c.stage, status: c.status || 'open',
    value: c.value, currency: extra.currency ?? null, close_date: c.closeDate, opened_date: extra.opened_date ?? null,
    pipeline: pl?.pipeline ?? cleanText(extra.pipeline), pipeline_id: pl?.pipeline_id ?? null,
    owner_name: extra.owner_name ?? null, owner_email: c.ownerEmail,
    owners: crmDealOwners(acc, extra.owner_name, c.ownerEmail),
    roster: c.roster, roster_known: c.roster.length > 0, last_stage_change_at: c.lastStageChangeAt, products: c.products,
  };

  const attributed = await attributedFor(supabase, workspaceId, dealId);
  const { people, activity, notes, health } = sliceForDeal(acc, deal, attributed);
  health.history = [];

  // Stage movement, dated from the CRM's own history (HubSpot property history).
  const { data: stageRows } = await supabase.from('observations').select('value, observed_at, raw')
    .eq('workspace_id', workspaceId).eq('entity_id', dealId).eq('property', 'stage')
    .order('observed_at', { ascending: true }).limit(500);
  // Every hop, the close included (dealStageOccupancies stops at the first terminal stage, which
  // is right for cycle-time maths and wrong for a timeline a person reads).
  // A re-sync writes the current stage again after the history; a repeat is not a move.
  const hops = dealStageHops(stageRows || []).filter((h, i, all) => i === 0 || h.label !== all[i - 1].label);
  const now = Date.now();
  const stages = hops.map((h, i) => {
    const next = hops[i + 1];
    const end = next ? Date.parse(next.at) : (h.status === 'open' ? now : Date.parse(h.at));
    return { label: h.label, status: h.status, entered_at: h.at, days: Math.max(0, Math.round((end - Date.parse(h.at)) / 86400000)), current: !next };
  });

  const { data: itemRows } = await supabase.from('observations').select('value, observed_at')
    .eq('workspace_id', workspaceId).eq('entity_id', dealId).like('property', 'line_item.%')
    .order('observed_at', { ascending: false }).limit(200);

  return {
    deal: { ...deal, days_in_stage: daysInStage(deal) },
    account: accountRef(company),
    people: people.map(p => ({ ...person(p), conversations: activity.filter(a => a.contact_id === p.id).length })),
    stages,
    line_items: (itemRows || []).map(r => ({ ...(r.value && typeof r.value === 'object' ? r.value : { value: r.value }), observed_at: r.observed_at })),
    activity: activity.slice(0, 150).map(a => ({ ...a, filed_to_deal: attributed.has(a.id) })),
    notes,
    // The account's topics; the page keeps the ones with a fact on this deal.
    intel_topics: await accountTopics(supabase, workspaceId, acc),
    health,
    attributed_count: attributed.size,
    // So the page can say whether this deal's pipeline is the workspace's primary one.
    primary_pipeline_ref,
    // Why it closed, as the dated path of evidence (GET-405). Null on an open deal or before the
    // daily pass has reached a closed one.
    close_record,
  };
}

function accountRef(company) {
  return { id: company.id, name: company.name || null, domain: company.domain || null };
}
