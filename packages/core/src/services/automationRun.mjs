// The automation engine (GET-426): a daily poll that turns a deal changing stage into an
// artifact somebody receives.
//
// IT LIVES IN CORE BECAUSE BOTH APPS RUN IT. The worker runs it on a cron; the API runs one
// automation on demand when somebody presses Test. It used to sit in apps/worker and the API
// imported it across the app boundary — which resolved on a dev machine, where the whole
// monorepo is on disk, and failed in production, where the api image contains apps/api and
// packages only. "Cannot find module /app/apps/worker/src/automations/dailyPoll.mjs" is what
// a path that only exists in development looks like once it ships.
//
// WHY A POLL AND NOT A WEBHOOK. A webhook is the right long-term shape — it fires in
// seconds and costs nothing while nothing happens. It also needs an endpoint per provider,
// a signature check per provider, a replay story and somewhere to put the events that
// arrive while we are deploying. A poll needs none of that, runs once a day, and is
// sufficient for "the deal closed yesterday, write it up". Start here; the dispatch below
// is the part a webhook would call anyway, so swapping the trigger later changes one file.
//
// WHAT A "DEAL" IS HERE. Nous resolves one account to one deal, and a CRM stage arrives as
// a `pipeline_stage` claim on the company (see metrics.mjs and stageDerivation.mjs). So a
// deal being won is that claim taking a won value, and the day it took it is valid_from.
// Reading the claim rather than the CRM means this works the same for HubSpot, Salesforce
// and a stage somebody typed, which is the whole reason the claim exists.
// Imported by path, not by package name: this file IS @nous/core, and a package that
// imports itself resolves to whatever is installed rather than to the source beside it.
import { getSupabaseClient } from '../db/client.js';
import { citeKey } from '../evidenceDetail.js';
import { writeDocument } from '../db/documents.js';
import { sendEmail } from '../utils/email.js';
import { createMessage, messageText } from '../llm/modelDoor.mjs';
import { renderDocumentPdf } from './briefPdf.mjs';
import { emitEvent } from './events.mjs';
import { filterDerivedForViewer, TEAM_VIEWER } from '../privacy/messagePrivacy.mjs';
import { hubspotTemplateVars } from './hubspotVars.mjs';
import { workspacesSubscribedTo } from '../db/triggers.js';
import { getInternalEntityIds } from '../db/teamMembers.js';
import { mirrorDraftAsDecision } from '../db/decisions.mjs';
import { getRelationshipOwners, effectiveOwnerUserId } from '../db/relationshipOwner.js';
import { runHubspotStep } from './hubspotAutomation.js';
import { readHubspotRecords } from './hubspotRead.mjs';
import { hubspotFieldChanges, entityForHubspotId, changeText, FIELD_CHANGE_WINDOW_MS } from './hubspotFieldTrigger.mjs';
import { crmFieldsFromConversation } from './crmFieldsFromConversation.mjs';
import { EMAIL_DRAFT_SYSTEM, parseEmailDraft } from './emailDraftBrief.mjs';

/** Text into HTML. A report quoting a customer must not be able to close our own markup. */
function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const WON = new Set(['closed_won', 'won', 'closedwon']);
const LOST = new Set(['closed_lost', 'lost', 'closedlost']);

/** Which trigger a stage value fires, or null when it fires none. */
// The automation triggers the daily pass runs on: deal outcomes and moves, and ICP tier moves.
const EVENT_TRIGGERS = ['deal_closed_won', 'deal_closed_lost', 'deal_stage_changed', 'icp_tier_changed'];

function triggerFor(stage) {
  const k = String(stage ?? '').toLowerCase().replace(/[\s-]/g, '_');
  if (WON.has(k)) return 'deal_closed_won';
  if (LOST.has(k)) return 'deal_closed_lost';
  return 'deal_stage_changed';
}

/**
 * The accounts whose stage changed since `since`, with the trigger each one fires.
 *
 * Reads the claim's own valid_from rather than a watermark we keep, so a poll that misses a
 * day catches up on the next run instead of losing the window — the claim is the record and
 * the poll is only a reader of it.
 */
// A HARD CEILING ON ONE PASS. The first version of this wrote hundreds of documents in a minute
// because it read every pipeline_stage claim whose computed_at fell in the window — and a
// nightly stage recompute touches every account that has ever been closed-won. A cap does
// not make that correct, but it makes it survivable: the run stops, says so, and somebody
// looks, instead of filling the graph while nobody is watching.
const MAX_RUNS_PER_PASS = 5;

/**
 * Deals that ACTUALLY CLOSED in the window, from deal_outcomes.
 *
 * This replaces reading pipeline_stage claims for the won/lost triggers, and the reason is
 * the whole bug. Those claims carry no usable date: valid_from is null on every one, and
 * computed_at is when we last RECOMPUTED, which the CRM sync moves every day. So a deal
 * closed on 2025-03-12 had a computed_at of this morning and was indistinguishable from one
 * closed this morning — which is how Quarry Ridge Motors, won well over a year ago and silent for
 * months, was written up as today's news.
 *
 * deal_outcomes.closed_at is the date the CRM actually recorded. Measured on one customer's
 * graph: no deals closed in the last day, a few dozen in the last 30 days, and the most recent
 * win was over a week old. A poll on the real date has nothing to write today,
 * which is the correct answer and the one the claims could never give.
 *
 * entity_id here is already the account — no contact rollup, and no person to mistake for a
 * company. It is still checked against `companies`, because a subject that is not an account
 * is the one failure worth never repeating.
 */
async function closedDeals(supabase, workspaceId, since, { newestFirst = false } = {}) {
  // PAGED, because a response stops at 1,000 rows without saying so. One customer holds thousands of
  // closed deals; read oldest-first in one request, the poll saw them up to a date years back and
  // never a deal that closed this week.
  const rows = [];
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await supabase
      .from('deal_outcomes')
      .select('entity_id, outcome, closed_at, deal_id')
      .eq('workspace_id', workspaceId)
      .in('outcome', ['won', 'lost'])
      .gte('closed_at', since)
      .order('closed_at', { ascending: !newestFirst })
      .order('deal_id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`deal outcomes read failed: ${error.message}`);
    rows.push(...(data ?? []).filter(d => d.entity_id));
    if (!data || data.length < 1000) break;
  }
  if (!rows.length) return [];

  const ids = [...new Set(rows.map(d => d.entity_id))];
  const isAccount = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const { data: cos, error: ce } = await supabase.from('companies')
      .select('id').eq('workspace_id', workspaceId).in('id', ids.slice(i, i + 100));
    if (ce) throw new Error(`account check failed: ${ce.message}`);
    for (const c of cos ?? []) isAccount.add(c.id);
  }

  // ONE WRITE-UP PER ACCOUNT PER STAGE, even when several deals closed together. An account
  // that closes several deals on the same day would otherwise get several identical summaries:
  // more noise and none of the information.
  const seen = new Set();
  const out = [];
  let skipped = 0;
  for (const d of rows) {
    if (!isAccount.has(d.entity_id)) { skipped++; continue; }
    const stage = d.outcome === 'won' ? 'closed_won' : 'closed_lost';
    const key = `${d.entity_id}:${stage}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ entityId: d.entity_id, dealId: d.deal_id ?? null, stage, trigger: triggerFor(stage), at: d.closed_at });
  }
  if (skipped) console.log(`[automations] skipped ${skipped} closed deal(s) that resolve to no account`);
  return out;
}

async function changedAccounts(supabase, workspaceId, since, { newestFirst = false } = {}) {
  // A STAGE MOVE HAS A REAL DATE TOO — it is just not on the claim.
  //
  // The claim holds current state: pipeline_stage = closed_won, computed_at = this morning,
  // valid_from null. Nothing in it says WHEN the account got there. But observations are
  // append-only and carry both `property` and `observed_at`, so the history is right there:
  // an account can read closed_won in 2022, then closed_won again three times this summer as
  // the sync re-observes it. The first is the move; the rest are the CRM
  // repeating itself, which is exactly what used to be mistaken for news.
  //
  // So: find the last point at which the value actually CHANGED, and fire on that date.
  //
  // Two steps, because knowing a value changed needs the value before it, and that can be
  // years earlier. Step one asks which accounts were touched at all inside the window — a
  // small set. Step two reads the full stage history for only those and decides whether what
  // happened was a move or a re-observation.
  const { data: touched, error: te } = await supabase
    .from('observations')
    .select('entity_id')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'state')
    .eq('property', 'pipeline_stage')
    .gte('observed_at', since);
  if (te) throw new Error(`stage observation read failed: ${te.message}`);
  const candidates = [...new Set((touched ?? []).map(o => o.entity_id).filter(Boolean))];
  if (!candidates.length) return [];

  const history = new Map();
  for (let i = 0; i < candidates.length; i += 100) {
    const { data: obs, error: oe } = await supabase
      .from('observations')
      .select('entity_id, value, observed_at')
      .eq('workspace_id', workspaceId)
      .eq('kind', 'state')
      .eq('property', 'pipeline_stage')
      .in('entity_id', candidates.slice(i, i + 100))
      .order('observed_at', { ascending: true });
    if (oe) throw new Error(`stage history read failed: ${oe.message}`);
    for (const o of obs ?? []) {
      const v = typeof o.value === 'string' ? o.value : o.value?.value;
      if (!v) continue;
      if (!history.has(o.entity_id)) history.set(o.entity_id, []);
      history.get(o.entity_id).push({ v, at: o.observed_at });
    }
  }

  // THE FIRST TIME THIS ACCOUNT REACHED THIS STAGE — not merely the last time the value
  // differed from the one before it.
  //
  // That weaker rule looked right and fired every day. The reason is that pipeline_stage
  // hangs on a CONTACT, and a contact can be on several deals: one entity here reads
  // closed_lost on 08-11, closed_won on 08-14, closed_lost on 08-16, closed_won on 08-19.
  // That is not a deal progressing, it is the sync reporting whichever of the contact's
  // eleven deals it looked at — won and lost ones, closing between 2021 and 2026. Any
  // "changed since last time" test reads that oscillation as news, once a day, forever.
  //
  // A stage an account has already been at is not a stage it just reached. This one entity
  // was closed_won in 2021, so today's closed_won is a repeat and says nothing. What
  // survives is an account arriving somewhere genuinely new, which is the only thing the
  // trigger was ever meant to mean.
  const moves = [];
  for (const [entityId, rows] of history) {
    const before = new Set();
    let prev = null;
    let first = null;
    for (const r of rows) {
      if (r.v !== prev) {
        if (prev !== null && !before.has(r.v) && String(r.at) >= since) { first = r; break; }
        prev = r.v;
      }
      before.add(r.v);
    }
    if (first) moves.push({ entityId, stage: first.v, at: first.at });
  }
  if (!moves.length) return [];

  // A STAGE OBSERVATION CAN SIT ON A PERSON, the same way the claim could. Roll it up to the
  // company and then confirm that company exists — an account summary about somebody who is
  // not an account is the wrong subject, not a thin one.
  const companyOf = new Map();
  const allIds = [...new Set(moves.map(m => m.entityId))];
  for (let i = 0; i < allIds.length; i += 100) {
    const { data: people, error: pe } = await supabase.from('contacts')
      .select('id, company_id').eq('workspace_id', workspaceId).in('id', allIds.slice(i, i + 100));
    if (pe) throw new Error(`contact rollup failed: ${pe.message}`);
    for (const p of people ?? []) if (p.company_id) companyOf.set(p.id, p.company_id);
  }
  const rolled = moves.map(m => ({ ...m, entityId: companyOf.get(m.entityId) ?? m.entityId }));

  const ids = [...new Set(rolled.map(c => c.entityId))];
  const isAccount = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const { data: cos, error: ce } = await supabase.from('companies')
      .select('id').eq('workspace_id', workspaceId).in('id', ids.slice(i, i + 100));
    if (ce) throw new Error(`account check failed: ${ce.message}`);
    for (const c of cos ?? []) isAccount.add(c.id);
  }

  rolled.sort((a, b) => (newestFirst
    ? String(b.at).localeCompare(String(a.at))
    : String(a.at).localeCompare(String(b.at))));
  const seen = new Set();
  const out = [];
  let skipped = 0;
  for (const r of rolled) {
    if (!isAccount.has(r.entityId)) { skipped++; continue; }
    const key = `${r.entityId}:${r.stage}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ entityId: r.entityId, stage: r.stage, trigger: triggerFor(r.stage), at: r.at });
  }
  if (skipped) console.log(`[automations] skipped ${skipped} stage move(s) that resolve to no account`);
  return out;
}

/**
 * Everything the graph holds about this account, gathered for the write-up.
 *
 * Five reads, because a handoff that only lists intel is a handoff that tells a new owner
 * what we believe and not who to call, what just happened, or what we already owe them.
 * Each one is capped: a model given four hundred sentences writes about the wrong four.
 */
// ── ICP changes (GET-588) ────────────────────────────────────────────────────
//
// An account's ICP score or tier moved. Every writer keeps the same trail on the open icp_fit
// prediction: when the score moves, the prior head goes into predicted_value.history and
// rescored_at is stamped; when it does not move, neither happens. So "what moved since X" is the
// open predictions with rescored_at >= X, each compared with its history[0]. That covers Nous's
// own re-score and a workspace's own scorer posting through /v2/scores alike.
//
// A first score (no history yet) is a change from nothing, flagged `first`: an account landing in
// Tier 1 the day it is scored is news. Scores are per person; accountId is the person's employer,
// which is what an automation writes about and what a record event is built around.
export async function icpChanges(supabase, workspaceId, since, { limit = 2000 } = {}) {
  const pick = 'id, entity_id, predicted_value, predicted_at, model_version';
  const [{ data: moved, error: e1 }, { data: fresh, error: e2 }] = await Promise.all([
    supabase.from('predictions').select(pick)
      .eq('workspace_id', workspaceId).eq('kind', 'icp_fit').is('resolved_at', null)
      .gte('predicted_value->>rescored_at', since).limit(limit),
    supabase.from('predictions').select(pick)
      .eq('workspace_id', workspaceId).eq('kind', 'icp_fit').is('resolved_at', null)
      .gte('predicted_at', since).limit(limit),
  ]);
  if (e1) throw new Error(`icp change read failed: ${e1.message}`);
  if (e2) throw new Error(`icp first-score read failed: ${e2.message}`);

  const byId = new Map();
  for (const p of [...(moved ?? []), ...(fresh ?? [])]) byId.set(p.id, p);
  const changes = [];
  for (const p of byId.values()) {
    const v = p.predicted_value ?? {};
    if (v.score == null || !p.entity_id) continue;
    const prior = Array.isArray(v.history) && v.history.length ? v.history[0] : null;
    if (prior && prior.score === v.score && prior.tier === v.tier) continue;
    // A score that moved because the MODEL changed is not news about the account (GET-689):
    // a new scorer or a re-learned scorecard re-scores everyone at once, and that must not
    // page every subscriber or run every automation. Only a move under the same model counts.
    if (prior && prior.model_version && p.model_version && prior.model_version !== p.model_version) continue;
    const at = v.rescored_at || p.predicted_at;
    if (!at || String(at) < String(since)) continue;
    changes.push({
      predictionId: p.id, personId: p.entity_id, at,
      from: prior ? { score: prior.score ?? null, tier: prior.tier ?? null } : null,
      to: { score: v.score, tier: v.tier ?? null },
      first: !prior,
      scorer: p.model_version ?? null,
      reason: v.reason ?? null,
    });
  }
  if (!changes.length) return [];

  // The employer of each person, so a change can be written up against the account.
  const people = [...new Set(changes.map(c => c.personId))];
  const employer = new Map();
  for (let i = 0; i < people.length; i += 100) {
    const { data: rels, error } = await supabase.from('relationships')
      .select('from_entity_id, to_entity_id')
      .eq('workspace_id', workspaceId).eq('type', 'works_at').is('valid_to', null)
      .in('from_entity_id', people.slice(i, i + 100));
    if (error) throw new Error(`employer read failed: ${error.message}`);
    for (const r of rels ?? []) if (!employer.has(r.from_entity_id)) employer.set(r.from_entity_id, r.to_entity_id);
  }
  for (const c of changes) c.accountId = employer.get(c.personId) ?? null;
  return changes.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

const TIER_LABEL = { tier_1: 'Tier 1', tier_2: 'Tier 2', tier_3: 'Tier 3', not_icp: 'Not ICP' };
const tierLabel = (t) => (t ? TIER_LABEL[t] ?? t : 'unscored');

/** The ICP tier moves, shaped like the deal changes the automation pass already runs on. */
async function icpTierChanges(supabase, workspaceId, since, { newestFirst = false } = {}) {
  const out = [];
  for (const c of await icpChanges(supabase, workspaceId, since)) {
    if (!c.first && c.from?.tier === c.to.tier) continue;           // score moved inside the tier
    if (c.first && !c.to.tier) continue;
    out.push({
      trigger: 'icp_tier_changed',
      entityId: c.accountId ?? c.personId,
      // What the write-up is about, in words: "ICP Tier 3 → Tier 1".
      stage: `ICP ${c.first ? 'scored' : tierLabel(c.from?.tier)} → ${tierLabel(c.to.tier)}`,
      at: c.at,
      // Each move is its own run: the same person can go Tier 3 → 2 → 3 → 2, and each is news.
      dedupe: `${c.predictionId}:${c.at}`,
      icp: c,
    });
  }
  return newestFirst ? out.reverse() : out;
}

async function gatherAccount(supabase, workspaceId, entityId) {
  const [{ data: co }, { data: intel }, { data: people }, { data: tasks }, { data: ws }, { data: deals }] = await Promise.all([
    supabase.from('companies').select('name, domain').eq('id', entityId).maybeSingle(),
    // The intel, newest first, with its category so the writer can tell a risk from a fact.
    supabase.from('claims').select('value, computed_at').eq('workspace_id', workspaceId).eq('entity_id', entityId)
      .gte('property', 'note.').lt('property', 'note/').is('invalid_at', null)
      .order('computed_at', { ascending: false }).limit(80),
    // Who is involved. A handoff whose first question is "who do I email" has failed.
    supabase.from('contacts').select('id, first_name, last_name, job_title, email')
      .eq('workspace_id', workspaceId).eq('company_id', entityId).limit(15),
    // And what we already owe them, so the new owner inherits the promises too.
    supabase.from('claims').select('value').eq('workspace_id', workspaceId).eq('entity_id', entityId)
      .gte('property', 'action_item.').lt('property', 'action_item/').is('invalid_at', null).limit(25),
    // Who WE are and what we sell. The ICP already says it, in the workspace's own words.
    supabase.from('workspaces').select('name, icp_text').eq('id', workspaceId).maybeSingle(),
    // THE DEAL ITSELF. A closed-won handoff that never says what was bought, for how much, or
    // when it closed is a profile of a company, not a handoff of a customer.
    supabase.from('deal_outcomes').select('outcome, value_usd, opened_at, closed_at')
      .eq('workspace_id', workspaceId).eq('entity_id', entityId)
      .order('closed_at', { ascending: false }).limit(10),
  ]);

  // EVERY FACT CARRIES WHERE IT CAME FROM — source_ref, the sentence somebody said, and who
  // said it — so the writer can cite it and a reader can open the call. A handoff whose
  // claims cannot be traced is a handoff you have to take on faith (GET-426).
  // A FACT IS A SENTENCE OR TWO, NOT A DOCUMENT (GET-739). An account's intel held whole pages
  // (a few dozen facts, over a million characters), and every AI step sent them all: hundreds of
  // thousands of tokens, tens of cents a step.
  const facts = (intel ?? [])
    .map(r => ({
      category: r.value?.category ?? 'general',
      label: clip(r.value?.label, 160),
      content: clip(r.value?.content, FACT_CHARS),
      ref: r.value?.metadata?.source_ref ?? null,
      quote: clip(r.value?.metadata?.quote, 400),
      speaker: r.value?.metadata?.speaker ?? null,
    }))
    .filter(f => typeof f.content === 'string' && f.content.trim())
    .slice(0, 35);

  // A `contacts` row is not always a person. One dealer group's two dozen include "Invoices
  // Desk", a boardroom mailbox and "Ostrander Motors Ltd. Kettlebrook" — a dealer company resolved
  // as staff, which is how the existing account summary came to open with "Ostrander Motors Ltd.
  // Kettlebrook is a company whose CEO, Gideon Tallow…". Two different organisations, merged into one
  // sentence that is simply false. Filtering here does not fix the resolution upstream; it
  // stops the handoff repeating its mistake.
  const looksLikeAPerson = (name, email) => {
    const n = String(name ?? '').trim();
    if (!n || n.includes('@')) return false;                       // a bare address is a mailbox
    if (/\b(inc|ltd|llc|corp|gmbh|motors|group|holdings|dealership)\b\.?$/i.test(n)) return false;
    if (/^(invoices?|accounts?|billing|info|sales|support|admin|noreply|boardroom|team)\b/i.test(n)) return false;
    if (/^(invoices?|accounts?|billing|info|sales|support|admin|noreply|boardroom)@/i.test(String(email ?? ''))) return false;
    return /\s/.test(n) || n.length > 2;                           // a first and last name, usually
  };

  const contacts = (people ?? []).filter(p => looksLikeAPerson(
    [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || p.email, p.email,
  )).map(p => ({
    id: p.id,
    name: [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || p.email || null,
    title: p.job_title ?? null,
    email: p.email ?? null,
  })).filter(p => p.name);

  // WHAT HAPPENED LATELY IS ON THE PEOPLE, NOT THE COMPANY. A company entity collects
  // `state` observations — CRM field values, one per sync — and none of them is a thing that
  // happened. The emails and the calls hang on the contacts, so that is where to look, and
  // anything without a subject or a summary is a row with nothing to say.
  let activity = [];
  // HOW THE DEAL ACTUALLY RAN. Counts and dates, not a sample — "eleven meetings over four
  // months" answers a question the last five subject lines cannot, and it is the first thing
  // somebody inheriting an account wants to know.
  let history = null;
  // WHO "WE" ARE, as the record shows it: the reps who own the engagements. Without this the
  // writer cannot tell our people from theirs — the Ashcombe Honda summary asked whether "Emeric
  // Solberg's company" was a competitor or a partner. It was us.
  const ourTeam = new Map();
  if (contacts.length) {
    const ids = contacts.map(c => c.id);
    // ONE ENGAGEMENT IS STORED ONCE PER CONTACT ON IT. hubspot_meetings_<id>_<contact> — a
    // meeting with four dealer staff on the invite is four rows, and counted as rows it is
    // four meetings and four lines of "recent activity". The engagement is the ref without
    // its trailing contact id.
    const engagementOf = (ref) => String(ref ?? '').replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '');
    const TRANSCRIPT = new Set(['fellow', 'fireflies', 'granola', 'fathom', 'cal_com', 'google_calendar']);
    // A meeting that was cancelled, rescheduled or not attended did not happen. HubSpot keeps
    // the booking either way; the outcome says which.
    const NOT_HELD = new Set(['CANCELED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED']);
    const channelOf = (source, ref, outcome) => {
      const r = String(ref ?? '');
      if (TRANSCRIPT.has(source)) return 'meeting';
      if (r.includes('/hubspot_meetings_')) return NOT_HELD.has(String(outcome ?? '').toUpperCase()) ? 'meeting_not_held' : 'meeting';
      if (r.includes('/hubspot_calls_')) return 'call';
      if (r.includes('/hubspot_emails_')) return 'email';
      if (r.includes('/hubspot_notes_')) return 'note';
      return 'other';
    };

    // MEETINGS USED TO MEAN "HAS A TRANSCRIPT". Every summary for one customer said 0 meetings, then
    // called the relationship email-only and told the new owner to book a first meeting — on
    // a workspace whose HubSpot holds hundreds of meetings and thousands of logged calls. One pass over the
    // rows, deduped by engagement, counts each channel and buckets the months.
    const monthly = new Map();
    const counted = new Set();
    const byChannel = { meeting: 0, call: 0, email: 0, note: 0 };
    let firstAt = null;
    for (let from = 0; from < 5000; from += 1000) {
      const { data: when } = await supabase.from('observations')
        .select('observed_at, source, source_ref, outcome:raw->>outcome')
        .eq('workspace_id', workspaceId).in('entity_id', ids).neq('kind', 'state')
        .order('observed_at', { ascending: true }).range(from, from + 999);
      for (const o of when ?? []) {
        const key = o.source_ref ? engagementOf(o.source_ref) : null;
        if (key && counted.has(key)) continue;
        if (key) counted.add(key);
        const ch = channelOf(o.source, o.source_ref, o.outcome);
        if (ch in byChannel) byChannel[ch]++;
        if (!firstAt && o.observed_at) firstAt = o.observed_at;
        const m = String(o.observed_at ?? '').slice(0, 7);
        if (m) monthly.set(m, (monthly.get(m) ?? 0) + 1);
      }
      if (!when || when.length < 1000) break;
    }
    const total = [...monthly.values()].reduce((a, b) => a + b, 0);
    const days = firstAt ? Math.round((Date.now() - new Date(firstAt).getTime()) / 86_400_000) : null;
    // FILL THE QUIET MONTHS WITH ZERO. Dropping a month with no activity closes the gap up
    // and draws a busy account; the four months nobody touched Quarry Ridge Motors are the single most
    // useful thing its chart has to say. A missing bar is a lie by omission.
    const seen = [...monthly.keys()].sort();
    const dense = [];
    if (seen.length) {
      const [y0, m0] = seen[0].split('-').map(Number);
      const [y1, m1] = seen[seen.length - 1].split('-').map(Number);
      for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? (m = 1, y++) : m++) {
        const key = `${y}-${String(m).padStart(2, '0')}`;
        dense.push([key, monthly.get(key) ?? 0]);
      }
    }
    const byMonth = dense.slice(-14);

    history = {
      first_interaction: firstAt ? String(firstAt).slice(0, 10) : null,
      last_interaction: byMonth.length ? byMonth[byMonth.length - 1][0] : null,
      days_since_first: days,
      total_interactions: total,
      meetings: byChannel.meeting,
      calls: byChannel.call,
      emails: byChannel.email,
      notes: byChannel.note,
      people_in_contact: contacts.length,
      by_month: byMonth.map(([month, count]) => ({ month, count })),
      busiest_month: byMonth.length ? byMonth.reduce((a, b) => (b[1] > a[1] ? b : a))[0] : null,
    };

    // source_ref COMES TOO, because an interaction is evidence. Every fact the writer was
    // allowed to cite came from a note.* claim, and an account can have none of those and
    // still have a year of email: Saltmarsh Auto had no intel claims and a few dozen interactions, every
    // one of them carrying a source_ref we simply never offered. That is why its handoff
    // cited nothing — not "no evidence", but evidence we held and did not hand over.
    const { data: acts } = await supabase.from('observations')
      .select('entity_id, kind, source, source_ref, value, raw, observed_at')
      .eq('workspace_id', workspaceId).in('entity_id', ids)
      .neq('kind', 'state')
      .order('observed_at', { ascending: false }).limit(150);
    const nameOf = new Map(contacts.map(c => [c.id, c.name]));
    // WHAT IT WAS, THEN WHAT HAPPENED IN IT. A HubSpot meeting's title is its description and
    // its "summary" is the invite body, so reading the summary first titled every meeting
    // "Join link for Google Meet". And a call summary is the richest thing HubSpot holds about
    // a dealer — 140 characters of it was the headline and none of the substance.
    const clean = (t) => String(t ?? '').replace(/\r/g, '').replace(/^Summary\s*/i, '').replace(/\s+/g, ' ').trim();
    const isInvite = (t) => /join (link|zoom|with google meet)|meet\.google\.com|zoom\.us\/j|teams\.microsoft/i.test(t);
    const byEngagement = new Map();
    for (const o of acts ?? []) {
      const key = o.source_ref ? engagementOf(o.source_ref) : `${o.entity_id}:${o.observed_at}`;
      const who = nameOf.get(o.entity_id) ?? null;
      const prior = byEngagement.get(key);
      if (prior) { if (who && !prior.with.includes(who)) prior.with.push(who); continue; }
      const channel = channelOf(o.source, o.source_ref, o.raw?.outcome);
      const title = clean(o.raw?.subject || o.value?.title || o.value?.description) || null;
      let detail = clean(o.value?.summary || o.raw?.body);
      if (!detail || isInvite(detail) || detail === title) detail = null;
      const cap = channel === 'email' ? 280 : 700;
      if (detail && detail.length > cap) detail = `${detail.slice(0, cap).replace(/\s+\S*$/, '')}…`;
      if (!title && !detail) continue;
      if (o.raw?.owner_name) {
        const t = ourTeam.get(o.raw.owner_name) ?? { name: o.raw.owner_name, email: o.raw.owner_email ?? null, engagements: 0 };
        t.engagements++;
        ourTeam.set(o.raw.owner_name, t);
      }
      byEngagement.set(key, {
        when: String(o.observed_at ?? '').slice(0, 10),
        channel,
        what: title ?? detail.slice(0, 140),
        detail: title ? detail : null,
        with: who ? [who] : [],
        our_rep: o.raw?.owner_name ?? null,
        source: o.source ?? null,
        ref: o.source_ref ?? null,
      });
    }
    // CONVERSATIONS FIRST, THEN MAIL. After a close, a nurture sequence sends a dealer an
    // email every few days — an account's most recent rows can all be "Your weekly Lumen digest"
    // and its siblings, pushing the demo with their managers out of the window. Calls, meetings and notes keep their places; email fills what is left.
    const all = [...byEngagement.values()];
    const talk = all.filter(a => a.channel !== 'email').slice(0, 14);
    const mail = all.filter(a => a.channel === 'email').slice(0, 20 - talk.length);
    activity = [...talk, ...mail]
      .sort((a, b) => String(b.when).localeCompare(String(a.when)))
      .map(({ with: w, ...a }) => ({ ...a, who: w[0] ?? null, with: w }));
  }

  // WHO IS ACTUALLY INVOLVED. Twelve sales associates with no activity is a staff list, not
  // a buying committee, and a handoff that opens with one buries the two names that matter.
  // Rank by evidence: appearing in the recent activity is the strongest signal, being named
  // in the intel is the next, and a title nobody has spoken to is last. The rest are not
  // dropped — they are counted, so the note says there are others without listing them.
  // Everyone on the engagement spoke, not only the contact the row happened to hang on —
  // Ansel Brightwater sat in the Ashcombe Honda demo and fell out of the table because he was
  // fourth on the invite.
  const spoke = new Set(activity.flatMap(a => a.with ?? []).filter(Boolean));
  const mentioned = new Set();
  for (const f of facts) {
    for (const c of contacts) if (c.name && f.content.includes(c.name.split(' ')[0])) mentioned.add(c.name);
  }
  const weight = (c) => (spoke.has(c.name) ? 2 : 0) + (mentioned.has(c.name) ? 1 : 0);
  // OUR PEOPLE ARE NOT THEIR BUYING COMMITTEE. A rep filed against the account as a contact
  // reads as a decision maker at the customer; their email domain says otherwise.
  const ourDomains = new Set([...ourTeam.values()].map(t => String(t.email ?? '').split('@')[1]).filter(Boolean));
  const ours = (c) => ourTeam.has(c.name) || ourDomains.has(String(c.email ?? '').split('@')[1]);
  const ranked = contacts.filter(c => !ours(c)).sort((a, b) => weight(b) - weight(a));
  const involved = ranked.filter(c => weight(c) > 0).slice(0, 8);
  const rest = ranked.length - involved.length;

  // WHAT WE SELL, from the ICP's own "What <us> sells" section when it has one — the part a
  // writer needs to know what "the portal" or "the scanner" is. The rest of the ICP is about whom we
  // sell to, which this account already answers.
  const icp = String(ws?.icp_text ?? '');
  const sells = (/^##\s*What\b[^\n]*\bsells?\b[^\n]*\n([\s\S]*?)(?=\n##\s|(?![\s\S]))/im.exec(icp)?.[1] ?? icp).trim().slice(0, 1800) || null;

  const toDay = (t) => (t ? String(t).slice(0, 10) : null);
  return {
    name: co?.name ?? null,
    domain: co?.domain ?? null,
    seller: {
      name: ws?.name ?? null,
      what_we_sell: sells,
      our_team: [...ourTeam.values()].sort((a, b) => b.engagements - a.engagements).slice(0, 6)
        .map(t => ({ name: t.name, engagements_on_this_account: t.engagements })),
    },
    deals: (deals ?? []).map(d => ({
      outcome: d.outcome,
      value_usd: d.value_usd ?? null,
      record_created: toDay(d.opened_at),
      closed: toDay(d.closed_at),
    })),
    facts,
    people: involved.map(({ id, ...rest }) => rest),
    people_not_shown: rest > 0 ? rest : 0,
    history,
    activity,
    owed: (tasks ?? []).map(t => t.value?.title).filter(Boolean).slice(0, 15),
  };
}

const HANDOFF_SYSTEM = `You write a short account brief for a colleague who is taking over an account that has just closed. It reads like the account page's AI Overview: a summary, then what we know. Its job is to save them from reading the emails and the CRM themselves — after two minutes with it they know what this account is, how the relationship developed and what was discussed, who matters and what is still open. Write in the register of an executive briefing: professional, direct, factual.

You are given everything the revenue graph holds: who we are and what we sell ("seller"), the deal ("deal", plus "other_deals_on_record"), what has been observed about the business ("intel"), who works there ("people"), the calls, meetings, emails and notes ("recent_activity"), the shape of the relationship ("deal_history"), and what we still owe them ("open_commitments"). Write FROM that. Never invent a fact, a name, a number, a date or a product that is not in it.

KNOW WHICH SIDE EVERYONE IS ON. "seller" is us. The people in "seller.our_team", the "our_rep" on an activity, and anyone the material places at our company are our colleagues — never the customer, a competitor or a third party. Everyone in "people" is the customer. Name what they bought in the words "seller.what_we_sell" uses.

BRIEF. The whole thing is under 400 words. A bullet is one line. No section repeats another.

"seller.what_we_sell" IS OUR CATALOGUE, NOT THIS CUSTOMER'S RECORD. Use it only for the names of things. Never take a module, a feature, a benefit or an objective from it that "intel" or "recent_activity" does not show for this account — what we sell is not what they bought, and our pitch is not what they want.

Dates are written 2026-09-21, or "September 2026" in prose. A role like "decision maker" or "led the decision" needs a cite, like every other claim about a person.

PLAIN. Say what the record says. Do not interpret patterns ("stalled", "accelerated", "momentum"), do not speculate about causes, do not assess risk in the abstract, and do not treat how the customer talks to us — phone, email, meetings — as meaningful. No generic advice. Leave out anything you would have to write as "none", "unknown" or "not stated". No bold, no tables, no preamble, no sign-off. Figures are digits ("13 calls", "$5,000").

RECENT AND RELEVANT FIRST. The reader is starting onboarding this week. What happened in the last few weeks and what is open now matters most; the older history is background. Within every section, lead with the most recent and most important item. Anything older than about six months gets at most one line in the whole brief.

"today" is given to you. Anything dated after today has not happened yet: write it as scheduled ("training is booked for 2026-10-01"), never as done.

Format, exactly — "## " headings, bullets start with "- ", in this order, and a section with nothing real in it is dropped:

## Executive Summary
Two sentences of prose, no bullets. The first says the account just closed: "Brackenridge Motors just closed won on 2026-09-25, buying the Lumen Insights Suite for $5,000." — with the product, and the value and date when given. The second says what this business is and where things stand now.

## What to Know for Onboarding
Three to five bullets, the most critical first: what the new owner must know or do in their first week. Recent, specific and cited — what is not set up yet, an open issue or unanswered question, a commitment coming due, who to contact first and why. Nothing here that is only background.

## Outstanding Items
Up to four bullets: what we committed to and have not visibly delivered, and what the customer still owes us — each with an owner. Skip anything already said in the section above.

## Stakeholders
Their side first, the most involved first, one bullet each, only people with a part in the record: "- Odile Fenwarth, Finance Manager — led implementation; raised payment reconciliation.[ce1n4]" Then one bullet for our side: "- Account team: Lucan Moberly (implementation), Signe Haverkamp (onboarding)." Names and roles only — no counts.

## Solution and Configuration
Up to five bullets: what they bought and how it is set up — modules, configuration, pricing or terms, who has access, the systems it works alongside.

## Customer Objectives
Up to three bullets, only what they said they want to achieve or asked for.

## Concerns Raised
Up to three bullets, most recent first: concerns or questions they raised, and whether each was resolved.

## Account History
Dated bullets, newest first, one per milestone or key discussion — never one per email: "- 2026-09-22: Pricing call with Barnaby Quell — group discount and a reporting add-on discussed.[cpxmd]" Four to seven bullets. Cover the last few months in these; fold everything older into one final bullet ("- Before 2026-06: first contact October 2025; two earlier deals lost, February and June 2026."). Leave out routine traffic — reminders, reschedules, marketing emails — and any entry whose notes are too thin to say what happened; never write that something is unclear.

IF THE DEAL WAS LOST ("account.stage" is Closed lost), keep the same shape: the Executive Summary says it just closed lost and why, as far as the record shows; "What to Know for Onboarding" becomes "Why It Was Lost"; and "Outstanding Items" becomes "Re-engagement Path" — or is left out if nothing in the record points there.

CITE WHAT YOU ASSERT BY COPYING ITS TOKEN. Every entry under "intel" or "recent_activity" that carries a "cite" field has a source behind it. Put that token in square brackets immediately after the line it supports, exactly as given, no space before the bracket — "...asked about payment reconciliation[ce1n4]." Several tokens sit side by side, each in its own brackets — "[c3f9x][c8k2p]" — never "[c3f9x, c8k2p]". COPY IT, never count: the tokens are not in order and are not numbers. At most two tokens per line, never cite an entry with no "cite" field, and never write a token you were not given.`;

/**
 * Citation tokens into the one shape the renderer links: "[c3f9x][c8k2p]", touching the text.
 *
 * The prompt asks for exactly that and a smaller model still writes "[cex06, c1fd4]" or puts
 * a space before the bracket, and either one renders as literal text with no source behind
 * it. A format we can fix for certain is not one to leave to the model.
 */
function tidyCites(text) {
  return String(text ?? '')
    .replace(/\s*\[(c[0-9a-z]{4}(?:\s*[,;]\s*c[0-9a-z]{4})*)\]/g,
      (_, list) => list.split(/\s*[,;]\s*/).map(t => `[${t}]`).join(''))
    .replace(/\](?:,\s*)\[(c[0-9a-z]{4})\]/g, '][$1]');
}

/**
 * A headline and sections out of "## " markdown.
 *
 * THIS USED TO ASK FOR JSON and it kept failing: the model answered over six thousand clean characters
 * and JSON.parse refused them, because a handoff's body is prose and prose has newlines in
 * it, and a newline inside a JSON string has to be escaped. Asking for a format that cannot
 * be broken by its own content is cheaper than repairing one that can.
 */
function parseHandoff(text) {
  const lines = String(text ?? '').replace(/^```[a-z]*\n?|```$/gm, '').split('\n');
  let headline = null;
  const sections = [];
  let current = null;
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      if (current) sections.push(current);
      // "## Where this stands — what kind of business" keeps only the name.
      current = { label: h[1].split(/\s+[—–]\s+/)[0].trim().slice(0, 80), body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else if (!headline && line.trim()) headline = line.trim();
  }
  if (current) sections.push(current);
  const out = sections
    .map(s => ({ label: s.label, body: s.body.join('\n').trim() }))
    .filter(s => s.body);

  // NO HEADINGS IS A VALID ANSWER. If somebody's prompt says "one short paragraph, no
  // sections", the model obeys and returns exactly that — and demanding "## " back would
  // reject it and fall through to the raw material, which is the override being quietly
  // undone. So: a body with no headings becomes one unlabelled section.
  if (!out.length) {
    const body = String(text ?? '').replace(/^```[a-z]*\n?|```$/gm, '').trim();
    if (body) return { headline: null, sections: [{ label: '', body }] };
  }
  return { headline, sections: out };
}

/**
 * Write the artifact.
 *
 * THIS USED TO BE A LIST. It read the intel claims, printed them as bullets under "What we
 * know", and stapled the user's prompt underneath as a section called "Asked for" — the
 * prompt was stored and displayed, never executed. Every document it produced said the same
 * thing about a different account, which is exactly what you would expect from a function
 * that never read the account it was writing about.
 *
 * So it writes now. The prompt the person typed is an instruction to the writer, appended to
 * ours rather than replacing it, because they are asking for a different emphasis and not a
 * different job. And if the model is unavailable the function still returns a document — the
 * gathered material, plainly laid out — because a handoff that is only sometimes there is
 * worse than a plain one that always is.
 */
// ── What the AI step reads (GET-568) ─────────────────────────────────────────
//
// The material is in parts, and each part can be switched off on the step: a handoff that
// should not mention pricing history leaves out the deals, one written for a new CSM leaves out
// our ICP. The account itself and today's date always go — without them there is nothing to
// write about and no way to tell a booked meeting from a finished one.
export const CONTEXT_PARTS = {
  deal: ['deal', 'other_deals_on_record', 'deal_history'],
  people: ['people', 'other_people_on_file'],
  activity: ['recent_activity'],
  intel: ['intel'],
  commitments: ['open_commitments'],
  seller: ['seller'],
};

/** The material with the parts this step switched off taken out. Unset means on. */
/** Text cut to n characters at a word, with an ellipsis. Pure. Non-strings pass through. */
function clip(t, n) {
  if (typeof t !== 'string') return t ?? null;
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 40))}…`;
}
export const FACT_CHARS = 900;
/** The most an AI step is ever handed, about 25k tokens (GET-739). */
export const MATERIAL_CHARS = 100_000;

/**
 * A hard ceiling on what one AI step reads (GET-739): past MATERIAL_CHARS, the oldest intel goes
 * first, then the oldest activity, then the transcript is shortened. Whatever an account holds, a
 * step costs a few credits, never hundreds. Pure.
 */
export function fitMaterial(material, max = MATERIAL_CHARS) {
  const size = (m) => JSON.stringify(m).length;
  if (size(material) <= max) return material;
  const out = { ...material, intel: [...(material.intel ?? [])], recent_activity: [...(material.recent_activity ?? [])] };
  while (size(out) > max && out.intel.length) out.intel.pop();
  while (size(out) > max && out.recent_activity.length) out.recent_activity.pop();
  if (size(out) > max && out.this_call?.transcript) {
    const over = size(out) - max;
    out.this_call = { ...out.this_call, transcript: out.this_call.transcript.slice(0, Math.max(0, out.this_call.transcript.length - over - 100)) };
  }
  return out;
}

function withContext(material, context) {
  if (!context || typeof context !== 'object') return material;
  const out = { ...material };
  for (const [part, keys] of Object.entries(CONTEXT_PARTS)) {
    if (context[part] === false) for (const k of keys) delete out[k];
  }
  return out;
}

/** The first AI step writes an email when it is Draft follow-up, else a brief (GET-718). */
function formatOf(a) {
  const st = (Array.isArray(a?.steps) ? a.steps : []).find(x => x?.type === 'agent');
  return st?.config?.mode === 'pick' && st?.config?.job === 'follow_up' ? 'email' : 'brief';
}

/** A document written as an email: its subject and body, or null. Pure. */
function emailParts(doc) {
  const sec = doc?.sections?.[0];
  return sec?.label === 'Email' ? { subject: doc.headline || null, body: String(sec.body ?? '').trim() } : null;
}

/** Which step (1-based) is the automation's AI step: the one whose model use a run is charged for. */
function agentStepOf(a) {
  const i = (Array.isArray(a?.steps) ? a.steps : []).findIndex(st => st?.type === 'agent');
  return i >= 0 ? i + 1 : 1;
}

async function makeArtifact(supabase, workspaceId, { artifact, entityId, stage, prompt, dryRun = false, context = null, materialOnly = false, signal = null, call = null, runId = null, agentStep = null, format = 'brief' }) {
  const g = await gatherAccount(supabase, workspaceId, entityId);
  const kind = artifact === 'call_score' ? 'call_score'
    : artifact === 'call_summary' ? 'call_summary' : 'account_summary';
  const name = g.name ?? 'This account';
  const stageLabel = String(stage).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const title = `${name} — ${stage.replace(/_/g, ' ')}`;

  // Numbered for citation. The model cites [n]; the sources are written in the same order,
  // and useDocCitations binds the two — the same path the wiki's own documents take.
  // EVERYTHING WITH A REF IS CITABLE — the intel AND the interactions. One numbering across
  // both, so [7] means the same thing wherever it appears, and one de-duplication, because
  // eleven emails in one thread are one source and eleven identical rows is not a bibliography.
  const seenRef = new Set();
  const cited = [];
  for (const f of g.facts) {
    if (!f.ref || seenRef.has(f.ref)) continue;
    seenRef.add(f.ref);
    cited.push({ ref: f.ref, detail: f.label ?? null, quote: f.quote ?? null, speaker: f.speaker ?? null, when: f.when ?? null });
  }
  for (const a of g.activity) {
    if (!a.ref || seenRef.has(a.ref)) continue;
    seenRef.add(a.ref);
    // The DATE comes with it. Three HubSpot notes that all open "Hello All," are three
    // indistinguishable rows in a source list; dated, they are three things a reader can tell
    // apart and go and find.
    cited.push({ ref: a.ref, detail: a.what ?? null, quote: null, speaker: a.who ?? null, when: a.when ?? null });
  }
  const sources = cited.map(c => ({
    system: String(c.ref).replace(/^source:\/\//, '').split('/')[0] || 'nous',
    ref: c.ref,
    detail: c.detail,
    quote: c.quote,
    speaker: c.speaker,
    // writeDocument reads `when` into document_sources.occurred_at.
    when: c.when,
  }));

  const wanted = stage === 'closed_lost' ? 'lost' : 'won';
  const thisDeal = g.deals.find(d => d.outcome === wanted) ?? null;
  const materialObject = fitMaterial(withContext({
    // "Deal status: closed_won" is a column name wearing a suit. The model echoes whatever
    // it is handed, so hand it the words a person would use.
    account: { name, domain: g.domain, stage: stageLabel },
    // WHAT FIRED IT, when a signal did (GET-686): the objection, the competitor, the new
    // stakeholder — said by whom, in their words, and when. The write-up is about this moment,
    // with the account as its background.
    ...(signal ? { trigger_signal: {
      type: SIGNAL_LABEL[signal.kind] ?? signal.label ?? signal.kind, what: signal.content ?? signal.title ?? null,
      quote: signal.quote ?? null, said_by: signal.speaker ?? null,
      said_on: signal.occurred_at ? String(signal.occurred_at).slice(0, 10) : null, detail: signal.detail ?? {},
      // The rest of what the same conversation raised (GET-834): one write-up answers all of it.
      ...(Array.isArray(signal.also) && signal.also.length ? { also_raised: signal.also.slice(0, 8).map((o) => ({
        type: SIGNAL_LABEL[o.kind] ?? o.kind, what: o.content ?? o.title ?? null, quote: o.quote ?? null, said_by: o.speaker ?? null,
      })) } : {}),
    } } : {}),
    // THE CALL THAT JUST ENDED, when one fired it (GET-706): who was on it, what the read found,
    // and the transcript itself, so a follow-up quotes what was actually said.
    ...(call ? { this_call: {
      title: call.title ?? null, date: call.occurredAt ? String(call.occurredAt).slice(0, 10) : null,
      with: (call.attendees ?? []).map(a => a.name || a.email).filter(Boolean),
      summary: call.summary ?? null,
      transcript: call.transcript ? String(call.transcript).slice(0, CALL_TRANSCRIPT_CHARS) : null,
    } } : {}),
    // So the writer can tell a booked session from a finished one.
    today: new Date().toISOString().slice(0, 10),
    seller: g.seller,
    // THE DEAL THIS IS ABOUT, AND THE REST AS BACKGROUND. Handed a flat list, the writer read
    // Ashcombe Honda's lost August deal and two unpriced September wins as one muddle and made
    // "uncertainty about deal size" its lead bullet. The one that fired the automation goes
    // first; the sales cycle is measured from the first interaction we hold, because the CRM's
    // deal record is often opened days before it is marked won and read as the cycle it said
    // "6 days" for an account worked for 11 months.
    deal: thisDeal && {
      ...thisDeal,
      days_from_first_contact_to_close: g.history?.first_interaction && thisDeal.closed
        ? Math.max(0, Math.round((new Date(thisDeal.closed) - new Date(g.history.first_interaction)) / 86_400_000))
        : null,
    },
    other_deals_on_record: g.deals.filter(d => d !== thisDeal),
    people: g.people,
    other_people_on_file: g.people_not_shown,
    recent_activity: g.activity.map(a => {
      const cite = a.ref ? citeKey(a.ref) : null;
      // THE RAW REF GOES. Shown both, a model reaches for the ref — it looks more like an
      // identifier — and pastes source://hubspot/… into the prose. A field it must not use
      // is a field it should not see.
      // `who` is the first of `with`; handing over both reads as two people.
      const { ref: _r, who: _w, ...rest } = a;
      return !cite ? rest : { cite, ...rest };
    }),
    deal_history: g.history,
    intel: g.facts.map(f => {
      const cite = f.ref ? citeKey(f.ref) : null;
      return !cite ? { content: f.content, category: f.category }
        : { cite, content: f.content, category: f.category, said_by: f.speaker, quote: f.quote };
    }),
    open_commitments: g.owed,
  }, context));
  // "View context" in the editor: exactly what the model would be handed, and nothing written.
  if (materialOnly) return { material: materialObject, sources };
  const material = JSON.stringify(materialObject);

  let headline = null;
  let sections = null;
  // AN EMAIL IS NOT A BRIEF (GET-718). Draft follow-up is written with the house email brief (the
  // same one Studio and the detectors use) and kept as its subject and body. Through the brief
  // writer it came back as sections, or as nothing when the model answered with an email.
  if (format === 'email' && !materialOnly) {
    try {
      const msg = await createMessage({
        feature: 'automation-handoff', tier: 'writing', max_tokens: 1200,
        system: prompt ? `${EMAIL_DRAFT_SYSTEM}\n\n---\n\nThe person who set this automation up asked for this specifically:\n\n${prompt}` : EMAIL_DRAFT_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(materialObject) }],
      });
      const requestId = runId ? `automation-run:${runId}:step:${agentStep ?? 1}` : null;
      Promise.resolve(STEP_HANDLERS.meter?.({ supabase, workspaceId, feature: 'automation-handoff', model: msg?.model ?? null, usage: msg?.usage ?? null, requestId }))
        .catch(() => {});
      const { subject, body } = parseEmailDraft(messageText(msg));
      if (body) { headline = subject; sections = [{ label: 'Email', body }]; }
    } catch (err) {
      console.warn('[automations] email writer unavailable:', err?.message ?? err);
    }
    if (dryRun) return { id: null, title: `${name} — follow-up`, headline, sections: sections ?? [], sources };
    return writeDocument(supabase, workspaceId, {
      kind: 'account_summary', title: `${name} — follow-up`, headline, subjectEntityId: entityId,
      sections: sections ?? [{ label: 'Email', body: '' }], sources, writtenBy: 'automation',
    });
  }
  try {
    const msg = await createMessage({
      feature: 'automation-handoff',
      tier: 'writing',
      // Enough room to finish. At 2000 the answer was being cut mid-JSON on an account
      // with fifty facts, the parse returned null, and the writer fell back silently — the
      // material was fine and the note looked unwritten.
      // The brief is under 350 words now; 2500 leaves room without inviting a long one.
      max_tokens: 2500,
      // THEIR INSTRUCTION OUTRANKS OURS, and says so. Everything above is a default for
      // somebody who did not tell us what they wanted; this person did. If they ask for two
      // hundred characters, two hundred characters is the answer and the nine sections are
      // not — a prompt that is quietly overruled by ours is a prompt box that lies.
      system: prompt
        ? `${HANDOFF_SYSTEM}\n\n---\n\nThe person who set this automation up asked for this specifically:\n\n${prompt}\n\nWhere that contradicts anything above — the sections, the length, the format, the order — THEIRS WINS. Everything above is what to do when nobody said otherwise. Somebody said otherwise.`
        : HANDOFF_SYSTEM,
      messages: [{ role: 'user', content: material }],
    });
    // Metered as the workspace's credits (GET-710): the process registers how (the API's tracker,
    // or the worker posting to it), so one price table decides what a run costs.
    // Tagged with the run and its AI step (GET-714), so History says what each run cost.
    const requestId = runId ? `automation-run:${runId}:step:${agentStep ?? 1}` : null;
    Promise.resolve(STEP_HANDLERS.meter?.({ supabase, workspaceId, feature: 'automation-handoff', model: msg?.model ?? null, usage: msg?.usage ?? null, requestId }))
      .catch(() => {});
    const raw = tidyCites(messageText(msg));
    const parsed = parseHandoff(raw);
    if (!parsed.sections.length) {
      // Say so. A silent fallback is indistinguishable from a model that was never called.
      console.warn(`[automations] writer answered ${raw.length} chars with no sections (finish: ${msg.finish_reason ?? msg.stop_reason ?? '?'}) — filing the material plainly`);
    } else {
      // Nothing above the first heading is kept. The prompt asks for none, so anything there
      // is the model talking to us — "I don't have access to file this directly…" was once
      // a brief's headline.
      sections = parsed.sections;
    }
  } catch (err) {
    console.warn('[automations] handoff writer unavailable, filing the material plainly:', err?.message ?? err);
  }

  if (!sections?.length) {
    // The honest fallback: what we gathered, labelled, with nothing claimed about it.
    sections = [
      g.activity.length && { label: 'Account History', body: g.activity.map(a => `- ${a.when}: ${a.what}${a.who ? ` (${a.who})` : ''}`).join('\n') },
      g.facts.length && { label: 'Solution and Configuration', body: g.facts.slice(0, 8).map(f => `- ${f.content}`).join('\n') },
      g.people.length && { label: 'Stakeholders', body: g.people.map(p => `- ${p.name}${p.title ? `, ${p.title}` : ''}`).join('\n') },
      g.owed.length && { label: 'Outstanding Items', body: g.owed.map(t => `- ${t}`).join('\n') },
    ].filter(Boolean);
    headline = headline ?? `${name} moved to ${stage.replace(/_/g, ' ')}.`;
  }

  // NO CHARTS, NO METRIC TILES. This is read like the account page's AI Overview — a few
  // lines of prose and some bullets — by somebody who wants to know what happened without
  // opening HubSpot. A strip of counts and a bar chart of monthly volume answered a question
  // nobody taking over an account asks first; the figures that matter are in the prose.

  // A dry run returns the same object the writer would have filed, unfiled. Reading it is
  // the only way to know whether it is worth filing.
  if (dryRun) return { id: null, title, headline, sections, sources };

  return writeDocument(supabase, workspaceId, {
    kind,
    title,
    headline,
    subjectEntityId: entityId,
    sections,
    sources,
    writtenBy: 'automation',
  });
}

/** The same writer, reachable by the one-account test. */
export const makeArtifactForTest = makeArtifact;
export const templateVarsForTest = (...args) => templateVars(...args);
export const tidyBodyForTest = (text) => tidyBody(text);
export const textToHtmlForTest = (text) => textToHtml(text);

/**
 * Send a document an automation already wrote, again — no rewrite, no new run.
 *
 * The recipients are read NOW, from the automation, so a resend reaches whoever is on it at
 * the moment it goes out (people added since the first send included). The date in the
 * subject is the deal's close date, as the first send had it.
 */
export async function resendAutomationDocument(supabase, workspaceId, { automationId, documentId }) {
  const [{ data: a, error: ae }, { data: doc, error: de }] = await Promise.all([
    supabase.from('agent_routines').select('*').eq('workspace_id', workspaceId).eq('id', automationId).maybeSingle(),
    supabase.from('documents').select('id, title, headline, sections, subject_entity_id, created_at')
      .eq('workspace_id', workspaceId).eq('id', documentId).is('deleted_at', null).maybeSingle(),
  ]);
  if (ae || !a) throw new Error(`automation ${automationId} not found${ae ? `: ${ae.message}` : ''}`);
  if (de || !doc) throw new Error(`document ${documentId} not found${de ? `: ${de.message}` : ''}`);
  const stage = /closed lost/i.test(doc.title ?? '') ? 'closed_lost' : /closed won/i.test(doc.title ?? '') ? 'closed_won' : null;
  let at = null;
  if (stage && doc.subject_entity_id) {
    const { data: d } = await supabase.from('deal_outcomes').select('closed_at')
      .eq('workspace_id', workspaceId).eq('entity_id', doc.subject_entity_id)
      .eq('outcome', stage === 'closed_won' ? 'won' : 'lost')
      .order('closed_at', { ascending: false }).limit(1).maybeSingle();
    at = d?.closed_at ?? null;
  }
  return deliver(a, doc, { stage, at, ctx: { supabase, workspaceId, entityId: doc.subject_entity_id, dealId: null } });
}

// ── The email the person wrote (GET-551) ────────────────────────────────────
//
// An email step carries To, Cc, Subject and Body. To and Cc have always reached the send, via
// destination_target; Subject and Body were saved and never read, so every run sent the fixed
// notice below whatever the editor said. Now a Subject or Body that is filled in IS the email,
// with its {{variables}} read from this run. Left empty, the notice is what goes, as before —
// an automation nobody has edited sends exactly what it sent yesterday. The PDF rides either way.

/** The flow's email step, when it has one. */
function emailStep(automation) {
  return (Array.isArray(automation?.steps) ? automation.steps : []).find(s => s?.type === 'email') ?? null;
}

const TEMPLATE_VAR = /\{\{\s*([A-Za-z_][\w-]*(?:\.[\w-]+)*)\s*\}\}/g;

/** `{{account.name}}` → its value. A variable this run has no value for reads as nothing. */
export function fillTemplate(text, vars) {
  return String(text ?? '').replace(TEMPLATE_VAR, (_, key) => (vars[key] == null ? '' : String(vars[key])));
}

const claimValue = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
const longDate = (d) => {
  const t = d ? new Date(d) : null;
  return t && !Number.isNaN(t.getTime())
    ? t.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
    : null;
};
const money = (n, currency = 'USD') => {
  const v = Number(n);
  if (n == null || n === '' || !Number.isFinite(v)) return null;
  try { return v.toLocaleString('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }); }
  catch { return v.toLocaleString('en-US', { maximumFractionDigits: 0 }); }
};

/** The document as plain text — what {{steps.<agent>.output}} stands for. Cite tokens dropped. */
function documentText(doc) {
  // An answer written as one plain paragraph is saved under "Summary" (GET-788): that heading is
  // for the page, not part of the message.
  const one = !doc?.headline && (doc?.sections ?? []).length === 1 && doc.sections[0].label === 'Summary';
  const parts = [doc?.headline, ...(doc?.sections ?? []).map(s => (one ? [s.body] : [s.label, s.body]).filter(Boolean).join('\n'))];
  return parts.filter(Boolean).join('\n\n').replace(/\s*\[c[0-9a-z]{4}\]/g, '').trim();
}

/**
 * Every variable an email can use on this run: the account, the deal that fired it, and each
 * agent step's output. Read once, at send time, from the same tables the app shows.
 */
async function templateVars(automation, doc, { stage = null, at = null, ctx = null, texts = [] } = {}) {
  const vars = {};
  const text = documentText(doc);
  for (const s of (Array.isArray(automation?.steps) ? automation.steps : [])) {
    if (s?.type === 'agent' && s.id) vars[`steps.${s.id}.output`] = text;
  }
  const docName = String(doc?.title ?? '').split(/\s+[—–]\s+/)[0].trim() || null;
  vars['account.name'] = docName;
  vars['deal.stage'] = stage ? stage.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()) : null;
  // The signal that fired it (GET-686): what kind, what was said, in whose words.
  const sig = ctx?.signal ?? null;
  if (sig) {
    vars['signal.type'] = SIGNAL_LABEL[sig.kind] ?? sig.label ?? sig.kind;
    vars['signal.text'] = sig.content ?? sig.title ?? null;
    vars['signal.quote'] = sig.quote ?? null;
    vars['signal.who'] = sig.speaker ?? null;
  }
  vars['deal.close_date'] = longDate(at);
  // The call that fired it (GET-706).
  const call = ctx?.call ?? null;
  if (call) {
    vars['call.title'] = call.title ?? null;
    vars['call.date'] = longDate(call.occurredAt);
    vars['call.attendees'] = (call.attendees ?? []).map(a => a.name || a.email).filter(Boolean).join(', ') || null;
    vars['call.summary'] = call.summary ?? null;
    vars['call.transcript'] = call.transcript ? String(call.transcript).slice(0, CALL_TRANSCRIPT_CHARS) : null;
    const steps = (call.nextSteps ?? []).filter(x => !x.theirs);
    vars['call.next_step'] = steps[0]?.title ?? null;
    vars['call.next_steps'] = steps.length ? steps.map(x => `- ${x.title}`).join('\n') : null;
  }

  const { supabase, workspaceId, entityId } = ctx ?? {};
  let dealId = ctx?.dealId ?? null;
  if (!supabase || !workspaceId || !entityId) return vars;

  let outcomeQ = supabase.from('deal_outcomes').select('deal_id, value_usd, closed_at').eq('workspace_id', workspaceId)
    .eq('entity_id', entityId);
  if (dealId) outcomeQ = outcomeQ.eq('deal_id', dealId);
  const [{ data: row }, { data: icp }, { data: outcome }] = await Promise.all([
    supabase.from('entity_list_rows').select('*').eq('workspace_id', workspaceId).eq('entity_id', entityId).maybeSingle(),
    supabase.from('predictions').select('predicted_value').eq('workspace_id', workspaceId).eq('kind', 'icp_fit')
      .eq('entity_id', entityId).order('predicted_at', { ascending: false }).limit(1).maybeSingle(),
    // The deal that fired it: the one named on the run, else this account's latest close.
    outcomeQ.order('closed_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (row) {
    vars['account.name'] = row.name ?? vars['account.name'];
    vars['account.domain'] = row.domain ?? null;
    vars['account.health'] = row.deal_health ?? null;
    vars['account.owner'] = row.owner_name ?? row.owner_email ?? null;
  }
  vars['account.tier'] = icp?.predicted_value?.tier ?? null;
  dealId = dealId ?? outcome?.deal_id ?? null;
  vars['deal.amount'] = money(outcome?.value_usd);

  if (dealId) {
    const { data: claims } = await supabase.from('claims').select('property, value')
      .eq('workspace_id', workspaceId).eq('entity_id', dealId).is('invalid_at', null)
      .in('property', ['name', 'stage', 'value', 'currency', 'close_date', 'owner_name', 'owner_email']);
    const c = Object.fromEntries((claims ?? []).map(r => [r.property, claimValue(r.value)]));
    vars['deal.name'] = c.name ?? null;
    vars['deal.amount'] = money(c.value, c.currency) ?? vars['deal.amount'];
    vars['deal.close_date'] = longDate(c.close_date) ?? vars['deal.close_date'];
    vars['deal.owner'] = c.owner_name ?? c.owner_email ?? null;
  }
  vars['account.owner'] = vars['account.owner'] ?? vars['deal.owner'] ?? null;
  Object.assign(vars, await personVars(supabase, workspaceId, { entityId, signal: sig, call }));
  // Any HubSpot property the texts name, read live for this deal and account (GET-567).
  Object.assign(vars, await hubspotTemplateVars(supabase, workspaceId, { dealId, accountId: entityId, texts }));
  return vars;
}

/**
 * {{person.email}} / {{person.name}} / {{person.title}}: who the email is to (GET-834). Every default "drafted for
 * you" automation addresses its Gmail draft to {{person.email}}, and nothing set it, so each draft
 * arrived with an empty To. In order: the person who raised the signal, else the first attendee of
 * the call with an address, else the account's most recently contacted person who is not on our
 * team. A person-level run (entityId is the person) is that person.
 */
export async function personVars(supabase, workspaceId, { entityId = null, signal = null, call = null } = {}) {
  const out = { 'person.email': null, 'person.name': null, 'person.title': null };
  const name = (c) => [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim() || null;
  const set = (c) => { if (c?.email) { out['person.email'] = String(c.email).trim(); out['person.name'] = name(c) ?? c.name ?? null; out['person.title'] = c.job_title ?? null; } return !!out['person.email']; };
  const byId = async (id) => {
    if (!id) return null;
    const { data } = await supabase.from('contacts').select('id, first_name, last_name, email, job_title').eq('workspace_id', workspaceId).eq('id', id).maybeSingle();
    return data ?? null;
  };
  try {
    if (signal?.entity_id && set(await byId(signal.entity_id))) return out;
    const attendee = (call?.attendees ?? []).find((a) => a?.email);
    if (attendee && set(attendee)) return out;
    if (!entityId) return out;
    if (set(await byId(entityId))) return out;   // the run is about a person
    const internal = await getInternalEntityIds(supabase, workspaceId).catch(() => new Set());
    const { data } = await supabase.from('contacts').select('id, first_name, last_name, email, job_title, last_interaction_at')
      .eq('workspace_id', workspaceId).eq('company_id', entityId).not('email', 'is', null)
      .order('last_interaction_at', { ascending: false, nullsFirst: false }).limit(25);
    set((data ?? []).find((c) => !internal.has(c.id)));
  } catch (e) {
    console.warn('[automation] person vars:', e?.message ?? e);
  }
  return out;
}

/**
 * The body as written, tidied: indentation it was pasted with removed, trailing spaces gone,
 * runs of blank lines collapsed to one. The person's line breaks are kept exactly.
 */
function tidyBody(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/, ''));
  const indents = lines.filter(l => l.trim()).map(l => l.match(/^[ \t]*/)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map(l => l.slice(cut)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Plain text into the mail's HTML: blank lines are paragraphs, single newlines are breaks. */
function textToHtml(text) {
  return String(text).split(/\n{2,}/).map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

/**
 * The email an automation sends, built but not sent: who it goes to, the subject and body,
 * and whether the PDF rides along. The send and the editor's preview both come through here,
 * so the preview is the email, not a picture of one (GET-664).
 */
export async function composeAutomationEmail(automation, doc, { stage = null, at = null, ctx = null } = {}) {
  // To first, the rest Cc — one thread, so a reply-all reaches everyone (GET-426).
  const [to, ...cc] = String(automation.destination_target ?? '').split(',').map(s => s.trim()).filter(Boolean);

  const appUrl = (process.env.APP_URL || 'https://app.opennous.cloud').replace(/\/$/, '');
  const link = `${appUrl}/pages/${doc.id}`;

  // THE MAIL IS A NOTICE, THE PDF IS THE BRIEF. It used to repeat the brief's title as a
  // heading and paste its first section in as a bullet — the same words the attachment opens
  // with, read twice. Now: who, when, what happened, and where the details are.
  const name = String(doc.title ?? '').split(/\s+[—–]\s+/)[0].trim() || 'This account';
  const outcome = String(stage ?? String(doc.title ?? '').split(/\s+[—–]\s+/)[1] ?? '')
    .replace(/_/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase()) || 'Updated';
  const day = new Date(at ?? doc.created_at ?? Date.now())
    .toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  let subject = `${name} · ${day} · ${outcome}`;
  // "closed won today" when it did; otherwise the date it closed.
  const closedOn = new Date(at ?? doc.created_at ?? Date.now()).toISOString().slice(0, 10);
  const when = closedOn === new Date().toISOString().slice(0, 10) ? 'today' : `on ${day}`;
  const first = `${name} ${outcome.toLowerCase()} ${when}.`;
  const second = `We created the account summary for you. You'll find it in the attached PDF, or you can read it in OpenNous`;

  let text = [first, '', `${second}: ${link}`].join('\n');

  // No font or size set: the mail reads in the reader's own client default, like a note
  // from a colleague rather than a newsletter.
  let html = [
    `<p>${escapeHtml(first)}</p>`,
    `<p>We created the account summary for you. You'll find it in the attached PDF, or you can <a href="${link}">read it in OpenNous</a>.</p>`,
  ].join('');

  // The person's own Subject and Body, when the email step has them. A filled-in field that
  // comes out blank (every variable in it empty) falls back to the notice, not to nothing.
  const step = emailStep(automation);
  const ownSubject = String(step?.config?.subject ?? '').trim();
  const ownBody = String(step?.config?.body ?? '').trim();
  if (ownSubject || ownBody) {
    const vars = await templateVars(automation, doc, { stage, at, ctx, texts: [ownSubject, ownBody] });
    const filledSubject = fillTemplate(ownSubject, vars).replace(/\s+/g, ' ').trim();
    const filledBody = tidyBody(fillTemplate(ownBody, vars));
    if (filledSubject) subject = filledSubject;
    if (filledBody) { text = filledBody; html = textToHtml(filledBody); }
  }

  // A PDF, because that is what opens the same on a phone, in a mail app and on a laptop,
  // and what somebody forwards. Unless the email step says to attach nothing (GET-566): the
  // AI output can ride in the body instead, through {{steps.<id>.output}}.
  const attach = step?.config?.attach !== 'none';
  // "Corrigan Autos Account Brief.pdf" — the name as the PDF titles it, no stray spaces.
  const filename = `${name.replace(/[^\w .&'-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70) || 'Account'} Account Brief.pdf`;
  return { to: to ?? null, cc, subject, text, html, attach, filename };
}

/** Deliver it. Home always has it — this is the extra copy. */
// ── The step runner (GET-543) ─────────────────────────────────────────────────
//
// An automation built on the canvas is a list of steps, and they run in order after the AI step
// writes its document:
//   only_if    the rules are checked against the run's variables; a miss ends the run quietly.
//   approval   everything that sends after it waits for a person: an email becomes a draft in
//              Priorities → To approve, approved from there (sent from the approver's own Gmail).
//   email      sent from OpenNous (the notice + PDF, or your own Subject and Body).
//   gmail      a real draft in the owner's own Gmail (their Drafts folder), never sent: a person
//              sends it. After an approval step it waits in Priorities instead, and approving
//              sends it from the approver's Gmail. With no Gmail connected it waits in Priorities.
//   webhook    a POST with the document and what fired it.
//   slack      posted by the workspace's Slack bot (a handler the API registers).
//   hubspot    writes back (GET-708): a note or a task on the deal, company and people, or the
//              fields you chose on the deal, contact or company. Held, like a send, behind an approval.
// Wait does not run yet; the run records that it stopped there, and the editor says so.
// An automation without steps (the old single-destination shape) delivers as it always did.

/** Handlers for steps that need the API's connections (Slack's bot token). Registered at boot. */
const STEP_HANDLERS = {};
export function registerStepHandler(type, fn) { STEP_HANDLERS[type] = fn; }

/** Does a value pass one "Only if" rule? Pure. */
export function rulePasses(rule, vars) {
  const raw = vars[rule?.field];
  const v = raw == null ? '' : String(raw).trim();
  const want = String(rule?.value ?? '').trim();
  const num = (x) => Number(String(x).replace(/[^0-9.-]/g, ''));
  switch (rule?.op) {
    case 'set': return v !== '';
    case 'not_set': return v === '';
    case 'is': return v.toLowerCase() === want.toLowerCase();
    case 'is_not': return v.toLowerCase() !== want.toLowerCase();
    case 'contains': return v.toLowerCase().includes(want.toLowerCase());
    case 'gt': return v !== '' && Number.isFinite(num(v)) && num(v) > num(want);
    case 'lt': return v !== '' && Number.isFinite(num(v)) && num(v) < num(want);
    default: return false;
  }
}
export function rulesPass(config, vars) {
  const rules = Array.isArray(config?.rules) ? config.rules.filter(r => r?.field) : [];
  if (!rules.length) return true;
  return config?.match === 'any' ? rules.some(r => rulePasses(r, vars)) : rules.every(r => rulePasses(r, vars));
}

/** Why this run happened, in one line, for the draft's "why" in Priorities. */
function runWhy(automation, { stage, ctx }) {
  if (ctx?.signal) return `${SIGNAL_LABEL[ctx.signal.kind] ?? ctx.signal.kind}: ${ctx.signal.content ?? ctx.signal.title ?? ''}`.trim();
  if (ctx?.call) return `After the call${ctx.call.title ? `: ${ctx.call.title}` : ''}`;
  return stage ? String(stage).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : (automation.name ?? null);
}

/** An email waiting in Priorities → To approve, labelled with the automation that wrote it. */
async function queueDraft(supabase, workspaceId, automation, { to, subject, body, entityId, why }) {
  const { data: action, error } = await supabase.from('pending_actions').insert({
    workspace_id: workspaceId, user_id: automation.user_id ?? null, kind: 'email', entity_id: entityId ?? null,
    recipient: to || null, recipient_email: to || null, subject: subject || 'Following up', body, rationale: why,
  }).select('*').single();
  if (error) throw new Error(`draft not queued: ${error.message}`);
  await mirrorDraftAsDecision(supabase, workspaceId, action, {
    actionType: 'email_send', category: 'outreach', surface: 'automation', agent: `routine:${automation.id}`,
    payload: { source: 'automation', automation_name: automation.name ?? 'Automation', routine_id: automation.id, why },
  }).catch(() => null);
  return action;
}

/** OpenNous's Draft follow-up drafts in Gmail itself, unless switched off or the flow has its own email step. */
function draftsItself(step, steps) {
  const c = step?.config ?? {};
  return step?.type === 'agent' && c.mode === 'pick' && c.job === 'follow_up' && c.model === 'opennous'
    && c.draft_in !== 'none' && !steps.some(x => x?.type === 'gmail' || x?.type === 'email');
}

// Where a run stopped, in words a person reads in History (GET-710): "Step 3 · HubSpot · Update the
// deal: no open deal on this account in HubSpot". A stop on purpose (an Only-if that did not match)
// is not a failure; everything else is.
const STEP_NAME = { agent: 'AI', only_if: 'Only if', approval: 'Approval', email: 'Email', gmail: 'Gmail', webhook: 'Webhook', slack: 'Slack', hubspot: 'HubSpot', wait: 'Wait', __followup_draft: 'Gmail draft' };
const HUBSPOT_ACTION_NAME = { read: 'Read records', note: 'Add a note', task: 'Create a task', update_deal: 'Update the deal', update_contact: 'Update the contact', update_company: 'Update the company' };
const REASON_TEXT = {
  condition_not_met: "the rules didn't match, so it stopped here",
  hubspot_not_connected: "HubSpot isn't connected", hubspot_no_record: 'this account has no record in HubSpot',
  hubspot_read_not_set: 'pick what to read: the object and at least one field', hubspot_trigger_not_set: 'pick the HubSpot object and the field to watch', hubspot_expired: 'the HubSpot connection expired. Reconnect HubSpot', hubspot_missing_scope: "the HubSpot connection can't read that object. Reconnect HubSpot",
  hubspot_no_deal: 'no open deal on this account in HubSpot', hubspot_no_contact: "the person isn't in HubSpot",
  hubspot_no_company: "the company isn't in HubSpot", hubspot_no_fields: 'no fields to set',
  slack_not_connected: "Slack isn't connected", slack_no_channel: 'no channel set', slack_channel_not_found: "Slack can't find that channel",
  slack_not_in_channel: "the OpenNous bot isn't in that channel. In Slack, type /invite @OpenNous in it", slack_not_available_here: "Slack couldn't be reached",
  slack_user_not_found: "Slack can't find that person", slack_cannot_dm_bot: "that's a bot, not a person", slack_is_archived: 'that channel is archived', slack_dm_failed: "Slack couldn't open a direct message",
  slack_missing_scope: 'the Slack connection is missing a permission. Reconnect Slack in Sources', slack_invalid_auth: 'the Slack connection expired. Reconnect Slack in Sources', slack_account_inactive: 'the Slack connection expired. Reconnect Slack in Sources',
  wait_not_running_yet: "Wait doesn't run yet", email_not_sent: "the email wasn't sent",
  gmail_expired: 'the Gmail connection expired, reconnect Gmail in Integrations',
  smtp_not_connected: "that SMTP mailbox isn't connected", smtp_no_recipient: 'no one to send it to', smtp_not_available_here: "the mailbox couldn't be reached",
};
export function describeStop(step, index, reason) {
  const words = REASON_TEXT[reason] ?? String(reason ?? '').replace(/^(hubspot|gmail|slack)_/, '').replace(/_/g, ' ');
  return `${stepName(step, index)}: ${words}`;
}

// Steps that act outside the app. Each can require approval (its own switch, or an Approval card
// above it): the run pauses there with a preview, and approving resumes at that very step (GET-713).
const ACTION_STEPS = new Set(['email', 'gmail', 'webhook', 'slack', 'hubspot', '__followup_draft']);

/** What a step's delivery tokens mean in words: "gmail_draft:you@x" → "Draft in Gmail (you@x)". Pure. */
export function describeDone(did) {
  return String(did ?? '').split(', ').filter(Boolean).map((t) => {
    const [k, ...rest] = t.split(':'); const v = rest.join(':');
    if (k === 'gmail_draft') return v ? `Draft in Gmail (${v})` : 'Draft in Gmail';
    if (k === 'gmail_sent') return v ? `Sent from Gmail (${v})` : 'Sent from Gmail';
    if (k === 'draft') return 'Draft waiting in Priorities';
    if (k === 'smtp_sent') return `Sent from ${v}`;
    if (k === 'email') return `Emailed ${v}`;
    if (k === 'slack') return `Posted to ${v}`;
    if (k === 'hubspot_read') return `Read ${v} ${v === '1' ? 'row' : 'rows'} with activity`;
    if (k === 'webhook') return 'Sent to the webhook';
    if (k === 'hubspot_tasks') return `${v} HubSpot task${v === '1' ? '' : 's'} created`;
    if (k === 'hubspot_task' && v === 'no_next_steps') return 'No next steps on this call';
    if (k === 'hubspot' && v === 'nothing_to_update') return 'Nothing to update from this conversation';
    if (k.startsWith('hubspot_update')) return `Updated ${v.split(',').join(', ')}`;
    if (k.startsWith('hubspot_')) return k === 'hubspot_note' ? 'Note added in HubSpot' : k === 'hubspot_task' ? 'Task created in HubSpot' : 'Done in HubSpot';
    return t;
  }).join(' · ');
}

const JOB_NAME = { follow_up: 'Draft follow-up', call_summary: 'Call summary', premeeting_brief: 'Pre-meeting brief', account_summary: 'Account summary', deal_handoff: 'Deal handoff' };

/** "Step 3 · HubSpot · Create a task", "Step 1 · OpenNous · Call summary". */
function stepName(step, index) {
  if (step?.type === '__followup_draft') return `Step ${index + 1} · Draft follow-up · Gmail`;
  if (step?.type === 'agent') {
    const c = step.config ?? {};
    return `Step ${index + 1} · ${c.mode === 'pick' ? `OpenNous · ${JOB_NAME[c.job] ?? 'Action'}` : 'AI · Your instructions'}`;
  }
  const what = STEP_NAME[step?.type] ?? step?.type ?? 'Step';
  const action = step?.type === 'hubspot' ? HUBSPOT_ACTION_NAME[step?.config?.action] : null;
  return `Step ${index + 1} · ${[what, action].filter(Boolean).join(' · ')}`;
}

/** What a run that pauses keeps, so approving can pick it up later: the trigger, minus the bulk. */
function resumeState({ stage, at, ctx }) {
  const call = ctx?.call ? { ...ctx.call, transcript: ctx.call.transcript ? String(ctx.call.transcript).slice(0, 20_000) : null } : null;
  return { stage, at, ctx: { entityId: ctx?.entityId ?? null, dealId: ctx?.dealId ?? null, signal: ctx?.signal ?? null, call } };
}

// What an OpenNous action asks for when it is not the automation's first AI step (GET-717): the
// same words its editor job sends (frontend lib/automations.ts JOBS), or the artifact it writes.
const JOB_PROMPTS = {
  follow_up: 'Draft the follow-up email for this call.\nIn my voice, short, with what we agreed, anything we promised to send, and one clear next step. Draft only; do not send.',
  premeeting_brief: 'Write a pre-meeting brief for this meeting.\nWho is attending and what each of them cares about, where the deal stands, what is still open from earlier conversations, and the two or three questions worth asking. Short, scannable, no preamble.',
  deal_handoff: 'Write the handoff from sales to customer success for this account.\nWhy they bought, who the people are and what each cares about, everything we promised, and the risks to watch in the first 90 days.',
};
const JOB_ARTIFACTS = { call_summary: 'call_summary', account_summary: 'account_summary' };

// THE DIGEST WRITER (GET-773). An AI step after a Read step writes from that data, not from one
// account: "yesterday's activity and what changed". Short, exact, for a channel.
const DIGEST_SYSTEM = `You write a short update from data a system read for you. It goes to a team's Slack channel or an email.

Rules:
- Use only the data given. Never invent a number, a name or a reason.
- First line: the headline totals and how they moved against the period before.
- Then the few rows that matter, grouped: the biggest, the biggest moves up or down, anything that stopped or started. One bullet each, name first. Rows that say the same thing share one line ("Went to zero: A (-3), B (-2), C (-1)").
- Numbers exactly as given, with the change in brackets. No commentary the numbers already say.
- A row without a real name (an id like "Record 123") is left out unless it is one of the biggest.
- No preamble, no sign-off, no em dashes. Under 150 words unless asked for more.`;

// Where the words go decides their markup (GET-791). Slack reads its own: *bold*, no headings.
const DIGEST_SLACK = `It is posted in Slack. Use Slack's markup only: *bold* (single asterisks) for the totals line and each group's name, "•" for bullets, a blank line between groups. No other markdown.`;

async function writeDigest(supabase, workspaceId, { prompt, data, runId, agentStep, title, slack = false }) {
  const material = [`Today: ${new Date().toISOString().slice(0, 10)}`, ...data.map(d => d.text)].join('\n\n');
  let text = '';
  try {
    const msg = await createMessage({
      feature: 'automation-handoff', tier: 'writing', max_tokens: 900,
      system: [slack ? `${DIGEST_SYSTEM}\n\n${DIGEST_SLACK}` : DIGEST_SYSTEM,
        prompt ? `---\n\nThe person who set this automation up asked for this specifically:\n\n${prompt}\n\nWhere that contradicts anything above, theirs wins.` : ''].filter(Boolean).join('\n\n'),
      messages: [{ role: 'user', content: material }],
    });
    const requestId = runId ? `automation-run:${runId}:step:${agentStep ?? 1}` : null;
    Promise.resolve(STEP_HANDLERS.meter?.({ supabase, workspaceId, feature: 'automation-handoff', model: msg?.model ?? null, usage: msg?.usage ?? null, requestId })).catch(() => {});
    text = messageText(msg).trim();
    if (!text) console.warn(`[automations] digest writer gave no answer (${msg?.model ?? '?'}, finish ${msg?.finish_reason ?? msg?.stop_reason ?? '?'}; ${(msg?.failed_attempts ?? []).map(f => `${f.model} ${f.reason}`).join('; ') || 'no other attempts'}), sending the data as read`);
  } catch (err) {
    console.warn('[automations] digest writer unavailable, sending the data as read:', err?.message ?? err);
  }
  // No model answer: the data itself is still exact and still worth sending, and the step says so.
  const fallback = !text;
  if (fallback) text = data.map(d => d.text).join('\n\n') || 'Nothing to report.';
  const doc = { title, headline: null, sections: [{ label: '', body: text }], fallback };
  if (!supabase) return doc;
  // Saved under a heading: a document keeps only labelled sections, and an unlabelled one was
  // dropped on save, so {{steps.<id>.output}} came out empty and Slack got the raw table instead
  // (GET-788). The steps after this one read the text itself, without the heading.
  return writeDocument(supabase, workspaceId, { kind: 'account_summary', title, headline: null, subjectEntityId: null, sections: [{ label: 'Summary', body: text }], sources: [], writtenBy: 'automation' })
    .then(d => ({ ...d, sections: doc.sections, fallback }), () => doc);
}

const isRead = (st) => st?.type === 'hubspot' && st?.config?.action === 'read';

async function runSteps(automation, firstDoc, { stage = null, at = null, ctx = null } = {}, resume = null) {
  const steps = automation.steps;
  // EACH AI STEP WRITES ITS OWN (GET-717). The first one's document comes in; every later AI step
  // writes another, and the steps after it read that one. docs[i] keeps each step's, so Draft
  // follow-up always drafts its own words wherever it sits.
  let doc = firstDoc;
  const docs = new Map();
  const firstAgent = steps.findIndex(x => x?.type === 'agent');
  // A Read step before the first AI step, or a scheduled run with no account (GET-772/773): that AI
  // step is written here, in order, from what the steps above it read.
  const writeInLoop = !!ctx?.writeAllInLoop || (firstAgent > 0 && steps.slice(0, firstAgent).some(isRead));
  if (firstAgent >= 0 && !resume && !writeInLoop) docs.set(firstAgent, firstDoc);
  // What the Read steps found, in order, for the AI steps after them and as {{steps.<id>.output}}.
  const stepData = [...(ctx?.seedData ?? [])];
  const extraVars = {};
  const done = [];
  const supabase = ctx?.supabase ?? null;
  const workspaceId = ctx?.workspaceId ?? null;
  const why = runWhy(automation, { stage, ctx });
  let vars = null;
  const varsFor = async (texts = []) => Object.assign(vars ?? (vars = await templateVars(automation, doc, { stage, at, ctx, texts })), extraVars);
  let gated = false;
  // A Draft follow-up with nowhere else to go drafts right after itself (GET-718), so a CRM step that
  // fails later cannot cost you the draft. An Approval card or a rule above it still applies.
  const followAt = steps.findIndex(x => draftsItself(x, steps));
  const plan = followAt >= 0 ? [...steps.slice(0, followAt + 1), { type: '__followup_draft', config: {} }, ...steps.slice(followAt + 1)] : steps;
  // The step's number as the canvas shows it: the draft is part of its follow-up card.
  const shownAt = (i) => (followAt >= 0 && i > followAt ? i - 1 : i);
  let at_ = -1;
  // What each step did, for the run's own page (GET-721): History shows the run, this shows the steps.
  const log = [];
  const note = (s, status, detail = null, extra = {}) => {
    if (s?.type === '__followup_draft') { const prev = log[log.length - 1]; if (prev && status === 'ok') { prev.detail = [prev.detail, detail].filter(Boolean).join(' · '); if (extra?.mail) prev.mail = extra.mail; return; } }
    log.push({ step: shownAt(at_) + 1, id: s?.id ?? null, type: s?.type ?? null, name: stepName(s, shownAt(at_)).replace(/^Step \d+ · /, ''), status, detail, ...extra });
    // A test run on the canvas watches the steps land (GET-724).
    Promise.resolve(ctx?.onLog?.(log.slice())).catch(() => {});
  };
  const stop = (s, reason) => {
    const message = describeStop(s, shownAt(at_), reason);
    note(s, reason === 'condition_not_met' ? 'stopped' : 'failed', message.replace(/^Step \d+ · [^:]+: /, ''));
    return { delivered: done.join(', ') || null, reason, failed: reason !== 'condition_not_met', message, log };
  };
  // "Account owner" (GET-722, the default): the email goes from the Gmail of whoever owns the
  // account, else from the automation's owner. A chosen mailbox always wins.
  let ownerUser;
  const draftUser = async (from) => {
    if (from?.id || from?.kind === 'smtp') return automation.user_id ?? null;
    if (ownerUser === undefined) {
      ownerUser = null;
      if (supabase && ctx?.entityId) {
        const owners = await getRelationshipOwners(supabase, workspaceId, [ctx.entityId]).catch(() => new Map());
        ownerUser = effectiveOwnerUserId(owners.get(ctx.entityId)) ?? null;
      }
    }
    return ownerUser ?? automation.user_id ?? null;
  };
  // The owner's Gmail first; when they have none, the automation owner's, before Priorities.
  // Where the last email went (GET-731), kept on the step's log line so the review can edit the
  // draft and send it from the same mailbox, and remove the draft it replaces.
  let lastMail = null;
  const draftInGmail = async (handler, from, { to, cc = null, subject, body }) => {
    let userId = await draftUser(from);
    let r = await handler({ supabase, workspaceId, userId, to, cc, subject, body, connectionId: from?.id ?? null });
    if (r?.status === 'no_gmail' && !from?.id && userId !== (automation.user_id ?? null) && automation.user_id) {
      userId = automation.user_id;
      r = await handler({ supabase, workspaceId, userId, to, cc, subject, body, connectionId: null });
    }
    if (r?.status === 'created' || r?.status === 'sent') {
      lastMail = { kind: r.status === 'sent' ? 'sent' : 'draft', draft_id: r.status === 'created' ? (r.id ?? null) : null, mailbox: r.mailbox ?? null,
        connection_id: from?.id ?? null, user_id: userId ?? null, to: to ?? null, cc: cc ?? null, subject, body };
    }
    return r;
  };
  /** The reviewer's edits to an email (GET-731): what they changed wins; `send` sends it instead of drafting. */
  const edited = (dec, msg) => {
    const e = dec?.email;
    if (!e || typeof e !== 'object') return { ...msg, send: false };
    const str = (v, d) => (typeof v === 'string' ? v.trim() : d);
    return { to: str(e.to, msg.to) || msg.to, cc: str(e.cc, null) || null, subject: str(e.subject, msg.subject) || msg.subject,
      body: typeof e.body === 'string' && e.body.trim() ? e.body.trim() : msg.body, send: e.send === true,
      // The mailbox the reviewer picked (GET-745); the API has already checked it is theirs.
      from: typeof e.from === 'string' && e.from ? e.from : null };
  };
  /** Draft it, or (approved with Send) send it now from the same Gmail. */
  const mailOut = async (from, msg) => {
    if (msg.from) from = { id: msg.from, kind: 'gmail' };
    const handler = msg.send ? STEP_HANDLERS.gmail_send : STEP_HANDLERS.gmail_draft;
    if (!handler) return msg.send ? { status: 'failed', error: 'send_not_available_here' } : null;
    return draftInGmail(handler, from, msg).catch(e => ({ status: 'failed', message: e.message }));
  };
  const sendSmtp = async (from, to, subject, body, cc = null) => {
    const handler = STEP_HANDLERS.smtp_send;
    if (!handler) return { ok: false, reason: 'smtp_not_available_here' };
    return handler({ supabase, workspaceId, connectionId: from?.id, to, cc, subject, body }).catch(e => ({ ok: false, reason: `smtp_failed: ${e.message}` }));
  };
  const clipText = (t, n = 700) => { const x = String(t ?? '').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
  // "Based on what was discussed" (GET-715): the AI's fields for an update step, worked out once per
  // step. An approval shows them and keeps them; approving writes exactly those, never a fresh guess.
  const aiFields = new Map();
  const isAiUpdate = (st) => st?.type === 'hubspot' && String(st.config?.action ?? '').startsWith('update_') && st.config?.fill === 'ai';
  const fieldsFor = async (st, idx = at_) => {
    const kept = resume?.inputs?.[idx]?.properties ?? (resume?.approvedIndex === idx ? resume?.inputs?.properties : null);
    if (Array.isArray(kept)) return kept;
    if (aiFields.has(idx)) return aiFields.get(idx);
    const r = await crmFieldsFromConversation({
      object: st.config.action, fields: (st.config.ai_fields ?? []).filter(Boolean),
      call: ctx?.call ?? null, signal: ctx?.signal ?? null, written: documentText(doc),
    });
    if (r.model && r.usage) {
      Promise.resolve(STEP_HANDLERS.meter?.({ supabase, workspaceId, feature: 'automation-handoff', model: r.model, usage: r.usage,
        requestId: ctx?.runId ? `automation-run:${ctx.runId}:step:${shownAt(idx) + 1}` : null })).catch(() => {});
    }
    aiFields.set(idx, r.fields);
    return r.fields;
  };
  /** What this step would do, filled in, for the person approving it. */
  const previewStep = async (s, idx = at_) => {
    const c = s?.config ?? {};
    let email = null, tasks = null, fields = null;
    const v = await varsFor([c.to, c.subject, c.body, c.text, c.title, ...(c.properties ?? []).map(p => p?.value)]);
    const fill = (t) => fillTemplate(String(t ?? ''), v).trim();
    const rows = [];
    if (s.type === 'email') {
      const m = await composeAutomationEmail(automation, doc, { stage, at, ctx });
      email = { from: null, to: m.to || null, subject: m.subject, body: m.text };
      rows.push(['To', m.to || '—'], ['Subject', m.subject], ['Body', clipText(m.text)]);
    } else if (s.type === 'gmail') {
      if (sendFromOf(s)?.email) rows.push(['From', sendFromOf(s).email]);
      email = { from: sendFromOf(s)?.email ?? null, to: fill(c.to) || null, subject: fill(c.subject) || emailParts(doc)?.subject || 'Following up', body: fill(c.body) || emailParts(doc)?.body || documentText(doc) };
      rows.push(['To', fill(c.to) || '—'], ['Subject', fill(c.subject) || 'Following up'], ['Body', clipText(fill(c.body) || documentText(doc))]);
    } else if (s.type === '__followup_draft') {
      const own = docs.get(steps.findIndex(x => draftsItself(x, steps)));
      if (own) doc = own;
      if (sendFromOf(s)?.email) rows.push(['From', sendFromOf(s).email]);
      email = { from: sendFromOf(s)?.email ?? null, to: (ctx?.call?.attendees ?? []).map(a => a?.email).filter(Boolean).join(', ') || null,
        subject: emailParts(doc)?.subject || (ctx?.call?.title ? `Following up: ${ctx.call.title}` : 'Following up'), body: emailParts(doc)?.body || documentText(doc) };
      rows.push(['To', (ctx?.call?.attendees ?? []).map(a => a?.email).filter(Boolean).join(', ') || '—'],
        ['Subject', emailParts(doc)?.subject || (ctx?.call?.title ? `Following up: ${ctx.call.title}` : 'Following up')], ['Body', clipText(emailParts(doc)?.body || documentText(doc))]);
    } else if (s.type === 'slack') {
      rows.push(['Channel', c.channel || '—'], ['Message', clipText(fill(c.text) || documentText(doc))]);
    } else if (s.type === 'webhook') {
      rows.push(['URL', c.url || '—']);
    } else if (s.type === 'hubspot') {
      if (c.action === 'task' && (c.task_from ?? (ctx?.call ? 'call' : 'one')) === 'call') {
        const owed = (ctx?.call?.nextSteps ?? []).filter(x => !x.theirs);
        tasks = owed.map((x, k) => ({ key: k, title: x.title, due_at: x.due_at ?? null }));
        rows.push(['Tasks', owed.length ? owed.map(x => `• ${x.title}`).join('\n') : 'No next steps on this call']);
      } else if (isAiUpdate(s)) {
        const f = await fieldsFor(s, idx);
        fields = f;
        if (!f.length) rows.push(['Fields', 'Nothing to update from this conversation']);
        for (const x of f) rows.push([x.name, `${x.value}  ·  "${clipText(x.quote, 160)}"`]);
      } else if (String(c.action ?? '').startsWith('update_')) {
        for (const p of (c.properties ?? []).filter(p => p?.name)) rows.push([p.name, fill(p.value) || '(empty, skipped)']);
      } else if (c.action === 'task') {
        tasks = [{ key: 0, title: fill(c.title) || 'Follow up', due_at: null }];
        rows.push(['Task', fill(c.title) || 'Follow up'], ['Notes', clipText(fill(c.body))]);
      } else {
        rows.push(['Note', clipText(fill(c.body) || documentText(doc))]);
      }
    }
    return {
      index: idx, step: stepName(s, shownAt(idx)), type: s.type, action: c.action ?? null,
      // A task with no date of its own is due this many days after it is approved (GET-731).
      ...(tasks ? { due_days: c.due_days ?? 1 } : {}),
      rows: rows.filter(([, val]) => val !== '').map(([label, value]) => ({ label, value: String(value) })),
      ...(email ? { email } : {}), ...(tasks ? { tasks } : {}), ...(fields ? { fields } : {}),
    };
  };
  const followCfg = steps.find(x => draftsItself(x, steps))?.config ?? {};
  // Draft follow-up's own draft ALWAYS waits for a person (GET-739): an email to a customer is
  // reviewed before it exists in their Gmail, with no switch to turn that off.
  const needsOk = (st, idx, gatedHere) => ACTION_STEPS.has(st?.type) && !isRead(st) && (gatedHere || st?.config?.approval === true
    || st?.type === '__followup_draft' || sendFromOf(st)?.kind === 'smtp') && !resume?.decisions?.[idx];
  // ONE REVIEW, NOT ONE AT A TIME (GET-724): the waiting step and every approvable step after it up to
  // the next AI step (whose words would change) are previewed together, each decided on its own.
  const bundleFrom = async (i) => {
    const items = [];
    let g = gated;
    for (let j = i; j < plan.length; j++) {
      const st = plan[j];
      if (st?.type === 'agent' || st?.type === 'only_if' || st?.type === 'wait') break;
      if (st?.type === 'approval') { g = true; continue; }
      if (needsOk(st, j, g)) items.push(await previewStep(st, j));
    }
    return items;
  };
  const pause = async (s) => {
    const bundle = await bundleFrom(at_);
    const preview = bundle[0] ?? await previewStep(s);
    if (supabase && workspaceId) {
      emitEvent(supabase, {
        workspaceId, type: 'automation.approval_requested', accountId: ctx?.entityId ?? null,
        occurredAt: new Date().toISOString(), dedupeKey: `${ctx?.runId ?? automation.id}:${at_}`,
        data: { run_id: ctx?.runId ?? null, automation: { id: automation.id, name: automation.name ?? null }, ...preview },
      }).catch(() => 0);
    }
    const inputs = Object.fromEntries([...aiFields.entries()].map(([k, v]) => [k, { properties: v }]));
    note(s, 'waiting', 'Waiting for approval');
    return { log, paused: true, index: at_, preview, bundle, delivered: done.join(', ') || null, resume: { ...resumeState({ stage, at, ctx }), steps, inputs, docId: doc?.id ?? null } };
  };
  // Where an email goes from (GET-716): the step's chosen mailbox, or for Draft follow-up its own.
  const sendFromOf = (st) => (st?.type === '__followup_draft' ? steps.find(x => draftsItself(x, steps))?.config?.send_from : st?.config?.send_from) ?? null;
  for (const s of plan) {
    at_ += 1;
    const c = s?.config ?? {};
    // SMTP has no drafts folder: an email from an SMTP mailbox always waits for a person to send it.
    const smtp = sendFromOf(s)?.kind === 'smtp';
    // Picking up after an approval: the steps before it already ran.
    if (resume && at_ < resume.startAt) { if (s?.type === 'approval') gated = true; continue; }
    const dec = resume?.decisions?.[at_] ?? (resume?.approvedIndex === at_ ? { approve: true } : null);
    if (!dec && needsOk(s, at_, gated)) return pause(s);
    // Skipped in review: this step does nothing, the rest go on.
    if (dec && dec.approve === false) { note(s, 'skipped', 'Skipped in review'); continue; }
    const doneBefore = done.length;
    switch (s?.type) {
      case 'agent': {
        if ((at_ === firstAgent && !writeInLoop) || !ctx?.supabase) { docs.set(at_, doc); break; }
        const job = c.mode === 'pick' ? c.job : null;
        // Its context (GET-791): the steps above it whose output it reads. Unset, every Read step
        // above it that isn't switched off (GET-788). An earlier AI step's words count when chosen.
        const chosen = Array.isArray(c.inputs) ? new Set(c.inputs) : null;
        const off = new Set(c.inputs_off ?? []);
        const fromAi = chosen ? steps.slice(0, at_).map((x, i) => ({ x, i }))
          .filter(({ x, i }) => x?.type === 'agent' && chosen.has(x.id) && docs.has(i))
          .map(({ x, i }) => ({ id: x.id, step: shownAt(i) + 1, label: 'AI', text: documentText(docs.get(i)) }))
          .filter(d => d.text) : [];
        const context = [...stepData.filter(d => (chosen ? chosen.has(d.id) : !off.has(d.id))), ...fromAi];
        if (stepData.length || !(c.account_id || ctx.entityId)) {
          // Data, not an account (GET-773): the digest writer, from the context chosen above. What
          // isn't chosen goes only where the instructions place {{steps.<id>.output}}.
          const raw = job ? [JOB_PROMPTS[job], String(c.extra ?? '').trim()].filter(Boolean).join('\n\n') : String(c.prompt ?? '').trim();
          const prompt = raw ? fillTemplate(raw, await varsFor([raw])).trim() : '';
          doc = await writeDigest(ctx.supabase, ctx.workspaceId, {
            prompt: prompt || null,
            data: context, runId: ctx.runId ?? null, agentStep: shownAt(at_) + 1, title: automation.name ?? 'Update',
            // A Slack step after it that posts these words: written in Slack's markup.
            slack: steps.slice(at_ + 1).some(x => x?.type === 'slack' && (!x.config?.text || String(x.config.text).includes(`steps.${s.id}.output`))),
          });
          docs.set(at_, doc);
          vars = null;
          break;
        }
        doc = await makeArtifact(ctx.supabase, ctx.workspaceId, {
          artifact: job ? (JOB_ARTIFACTS[job] ?? null) : null,
          // An account's writer keeps the account; earlier AI steps chosen as context ride in the ask.
          prompt: [job ? [JOB_PROMPTS[job], String(c.extra ?? '').trim()].filter(Boolean).join('\n\n') : String(c.prompt ?? '').trim(),
            ...fromAi.map(d => `What step ${d.step} wrote:\n${d.text}`)].filter(Boolean).join('\n\n') || null,
          entityId: c.account_id || ctx.entityId, stage: stage ?? 'automation', context: c.context ?? null,
          signal: ctx.signal ?? null, call: ctx.call ?? null, runId: ctx.runId ?? null, agentStep: shownAt(at_) + 1,
          format: job === 'follow_up' ? 'email' : 'brief',
        });
        docs.set(at_, doc);
        vars = null;   // the variables read the newest document
        break;
      }
      case 'only_if':
        if (!rulesPass(c, await varsFor((c.rules ?? []).map(r => `{{${r.field}}}`)))) {
          return stop(s, 'condition_not_met');
        }
        break;
      case 'approval':
        gated = true;
        break;
      case 'email': {
        const mail = await composeAutomationEmail(automation, doc, { stage, at, ctx });
        if (!mail.to) break;
        const pdf = mail.attach ? await renderDocumentPdf(doc, { writtenAt: doc.created_at ?? new Date() }) : null;
        const res = await sendEmail({
          to: mail.to, cc: mail.cc.length ? mail.cc : undefined,
          subject: mail.subject, text: mail.text, html: mail.html,
          attachments: pdf ? [{ filename: mail.filename, content: pdf.toString('base64') }] : undefined,
          tag: 'AUTOMATION',
        });
        if (res.sent) done.push(`email:${mail.to}${mail.cc.length ? ` +${mail.cc.length} cc` : ''}`);
        else return stop(s, res.reason ?? 'email_not_sent');
        break;
      }
      case 'gmail': {
        if (!supabase) break;
        const v = await varsFor([c.to, c.subject, c.body]);
        const to = fillTemplate(String(c.to ?? ''), v).split(',').map(x => x.trim()).filter(Boolean)[0] ?? null;
        const subject = fillTemplate(String(c.subject ?? ''), v).replace(/\s+/g, ' ').trim()
          || emailParts(doc)?.subject || String(doc.title ?? '').split(/\s+[—–]\s+/)[0].trim() || 'Following up';
        const m = edited(dec, { to, subject, body: tidyBody(fillTemplate(String(c.body ?? ''), v)) || emailParts(doc)?.body || documentText(doc) });
        if (smtp) {
          const r = await sendSmtp(sendFromOf(s), m.to, m.subject, m.body, m.cc);
          if (!r.ok) return stop(s, r.reason ?? 'smtp_failed');
          done.push(`smtp_sent:${r.from ?? sendFromOf(s)?.email ?? ''}`);
          break;
        }
        const r = await mailOut(sendFromOf(s), m);
        if (r) {
          if (r.status === 'created') { done.push(`gmail_draft${r.mailbox ? `:${r.mailbox}` : ''}`); break; }
          if (r.status === 'sent') { done.push(`gmail_sent${r.mailbox ? `:${r.mailbox}` : ''}`); break; }
          if (r.status !== 'no_gmail') return stop(s, r.error === 'expired' ? 'gmail_expired' : `gmail_${r.error ?? 'failed'}${r.message ? `: ${r.message}` : ''}`);
        }
        await queueDraft(supabase, workspaceId, automation, { to: m.to, subject: m.subject, body: m.body, entityId: ctx?.entityId, why });
        done.push('draft:to_approve');
        break;
      }
      case 'webhook': {
        if (!c.url) break;
        const v = await varsFor();
        const r = await fetch(c.url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            automation: { id: automation.id, name: automation.name ?? null },
            title: doc.title, headline: doc.headline ?? null, document_id: doc.id, text: documentText(doc),
            trigger: stage, account: { id: ctx?.entityId ?? null, name: v['account.name'] ?? null },
            ...(ctx?.signal ? { signal: { type: ctx.signal.kind, text: ctx.signal.content ?? null, quote: ctx.signal.quote ?? null, who: ctx.signal.speaker ?? null } } : {}),
            ...(ctx?.call ? { call: { title: ctx.call.title ?? null, date: ctx.call.occurredAt ?? null, summary: ctx.call.summary ?? null } } : {}),
          }),
        }).catch(e => ({ ok: false, statusText: e.message }));
        if (!r.ok) return stop(s, `webhook_failed: ${r.status ?? ''} ${r.statusText ?? ''}`.trim());
        done.push('webhook');
        break;
      }
      case 'slack': {
        const handler = STEP_HANDLERS.slack;
        if (!handler) return stop(s, 'slack_not_available_here');
        const v = await varsFor([c.text]);
        const text = fillTemplate(String(c.text ?? ''), v).trim() || documentText(doc) || stepData.map(d => d.text).join('\n\n');
        // A channel or a person (GET-771): picked from the connected Slack, by id.
        const dm = c.action === 'dm';
        const r = await handler({ supabase, workspaceId, channel: String(c.channel ?? '').trim(),
          channelId: dm ? null : (c.channel_id ?? null), userId: dm ? (c.user_id ?? null) : null, text }).catch(e => ({ ok: false, reason: e.message }));
        if (!r?.ok) return stop(s, r?.reason ?? 'slack_failed');
        done.push(`slack:${dm ? (c.user_name ?? 'a direct message') : `#${String(c.channel ?? '').replace(/^#/, '')}`}`);
        break;
      }
      case 'hubspot': {
        if (!supabase) break;
        if (c.action === 'read') {
          // Read records (GET-773): the table goes to the AI step after it and to {{steps.<id>.output}}.
          const r = await readHubspotRecords(supabase, workspaceId, c);
          if (!r.ok) return stop(s, r.reason);
          stepData.push({ id: s.id ?? null, step: shownAt(at_) + 1, label: c.object_label ?? c.object, text: r.text });
          if (s.id) extraVars[`steps.${s.id}.output`] = r.text;
          done.push(`hubspot_read:${r.count}`);
          break;
        }
        const v = await varsFor([c.title, c.body, ...(c.properties ?? []).map(p => p?.value)]);
        const fill = (t) => fillTemplate(String(t ?? ''), v).trim();
        // Tasks from the call (GET-710): one HubSpot task per next step we owe, on the same records.
        if (c.action === 'task' && (c.task_from ?? (ctx?.call ? 'call' : 'one')) === 'call') {
          const all = (ctx?.call?.nextSteps ?? []).filter(x => !x.theirs);
          // Each task approved on its own (GET-724): only the ticked ones are created.
          const owed = Array.isArray(dec?.tasks) ? all.filter((_, k) => dec.tasks.includes(k)) : all;
          if (!owed.length) { done.push(all.length ? 'hubspot_task:none_approved' : 'hubspot_task:no_next_steps'); break; }
          let made = 0;
          for (const item of owed) {
            const days = item.due_at ? Math.max(0, Math.ceil((Date.parse(item.due_at) - Date.now()) / 86_400_000)) : (c.due_days ?? 1);
            const r = await runHubspotStep(supabase, workspaceId, {
              action: 'task', title: item.title, body: ctx?.call?.title ? `From the call: ${ctx.call.title}` : '', dueDays: days,
              accountEntityId: ctx?.entityId ?? null, dealEntityId: ctx?.dealId ?? null,
              personEmails: (ctx?.call?.attendees ?? []).map(a => a?.email).filter(Boolean),
            });
            if (!r.ok) return stop(s, r.reason);
            made++;
          }
          done.push(`hubspot_tasks:${made}`);
          break;
        }
        const props = isAiUpdate(s)
          ? (await fieldsFor(s)).map(x => ({ name: x.name, value: x.value }))
          : (c.properties ?? []).filter(p => p?.name).map(p => ({ name: p.name, value: fill(p.value) }));
        if (isAiUpdate(s) && !props.length) { done.push('hubspot:nothing_to_update'); break; }
        const r = await runHubspotStep(supabase, workspaceId, {
          action: c.action ?? 'note', title: fill(c.title), body: fill(c.body) || documentText(doc), dueDays: c.due_days ?? 1,
          properties: props,
          accountEntityId: ctx?.entityId ?? null, dealEntityId: ctx?.dealId ?? null,
          personEmails: (ctx?.call?.attendees ?? []).map(a => a?.email).filter(Boolean),
          personEntityIds: ctx?.signal?.entity_id ? [ctx.signal.entity_id] : [],
        });
        // Nothing the run found to write (every field came out empty) is not a failure (GET-712).
        if (!r.ok && r.reason === 'hubspot_no_fields') { done.push('hubspot:nothing_to_update'); break; }
        if (!r.ok) return stop(s, r.reason);
        done.push(r.did);
        break;
      }
      case '__followup_draft': {
        // Draft follow-up's own draft: to the people on the call, in the owner's Gmail, in its own words.
        const own = docs.get(steps.findIndex(x => draftsItself(x, steps)));
        if (own) doc = own;
        const to = (ctx?.call?.attendees ?? []).map(a => a?.email).filter(Boolean).join(', ') || null;
        const mail = emailParts(doc);
        const m = edited(dec, { to, subject: mail?.subject || (ctx?.call?.title ? `Following up: ${ctx.call.title}` : 'Following up'), body: mail?.body || documentText(doc) });
        if (smtp) {
          const r = await sendSmtp(sendFromOf(s), m.to, m.subject, m.body, m.cc);
          if (!r.ok) return stop(s, r.reason ?? 'smtp_failed');
          done.push(`smtp_sent:${r.from ?? sendFromOf(s)?.email ?? ''}`);
          break;
        }
        const r = supabase ? await mailOut(sendFromOf(s), m) : null;
        if (r) {
          if (r.status === 'created') { done.push(`gmail_draft${r.mailbox ? `:${r.mailbox}` : ''}`); break; }
          if (r.status === 'sent') { done.push(`gmail_sent${r.mailbox ? `:${r.mailbox}` : ''}`); break; }
          if (r.status !== 'no_gmail') return stop(s, r.error === 'expired' ? 'gmail_expired' : `gmail_${r.error ?? 'failed'}${r.message ? `: ${r.message}` : ''}`);
        }
        if (supabase) {
          await queueDraft(supabase, workspaceId, automation, { to: m.to?.split(',')[0]?.trim() ?? null, subject: m.subject, body: m.body, entityId: ctx?.entityId, why });
          done.push('draft:to_approve');
        }
        break;
      }
      default:
        // wait: not running yet. Stop here so nothing after it runs out of order.
        return stop(s, `${s?.type}_not_running_yet`);
    }
    // The step went through: say what it did, in words (and which document an AI step wrote).
    if (s?.type === 'agent') {
      if (doc?.fallback) note(s, 'ok', 'No answer from the AI, so the data went on as read', { document_id: doc?.id ?? null });
      else note(s, 'ok', doc?.title ? `Wrote ${emailParts(doc) ? 'the email' : `"${String(doc.headline || doc.title).slice(0, 80)}"`}` : 'Wrote it', { document_id: doc?.id ?? null });
    } else if (s?.type === 'only_if') {
      note(s, 'ok', 'The rules matched');
    } else if (s?.type !== 'approval') {
      const did = done.slice(doneBefore).join(', ');
      note(s, 'ok', describeDone(did) || 'Nothing to do', {
        ...(s?.type === '__followup_draft' && doc?.id ? { document_id: doc.id } : {}),
        ...((s?.type === '__followup_draft' || s?.type === 'gmail') && lastMail ? { mail: lastMail } : {}),
      });
      lastMail = null;
    }
  }
  return { delivered: done.join(', ') || null, log };
}

export const runStepsForTest = (automation, doc, opts, resume) => runSteps(automation, doc, opts, resume);

/**
 * Approve or skip a run that is waiting on a step (GET-713). Approving runs that step, then the
 * rest of the automation, which may pause again on a later step. Skipping ends the run as
 * rejected. Claimed atomically, so two people pressing at once run it once.
 * @returns { ok, status, delivered?, message?, error? }
 */
export async function decideAutomationRun(supabase, workspaceId, runId, { approve, userId = null, decisions = null } = {}) {
  const { data: run } = await supabase.from('agent_routine_runs').select('*')
    .eq('workspace_id', workspaceId).eq('id', runId).maybeSingle();
  if (!run) return { ok: false, error: 'not_found' };
  if (run.status !== 'awaiting_approval') return { ok: false, error: 'not_waiting', status: run.status };
  const st = run.state ?? {};
  const who = userId ? ` by ${userId}` : '';
  const { data: claimed } = await supabase.from('agent_routine_runs')
    .update(approve ? { status: 'running' } : { status: 'rejected', error: `Skipped at ${st.preview?.step ?? 'a step'}` })
    .eq('id', runId).eq('status', 'awaiting_approval').select('id');
  if (!claimed?.length) return { ok: false, error: 'already_decided' };
  const log = (entry) => supabase.from('agent_routine_runs')
    .update({ step_log: [...(Array.isArray(run.step_log) ? run.step_log : []), { ...entry, at: new Date().toISOString(), by: userId }] })
    .eq('id', runId).then(() => null, () => null);
  if (!approve) { await log({ step: st.preview?.step ?? null, decision: 'rejected' }); return { ok: true, status: 'rejected' }; }

  const { data: automation } = await supabase.from('agent_routines').select('*').eq('id', run.routine_id).maybeSingle();
  const docId = st.resume?.docId ?? run.document_id;
  const { data: doc } = docId
    ? await supabase.from('documents').select('*').eq('id', docId).maybeSingle()
    : { data: null };
  if (!automation) {
    await supabase.from('agent_routine_runs').update({ status: 'error', error: 'The automation was deleted' }).eq('id', runId);
    return { ok: false, error: 'automation_deleted' };
  }
  const res = st.resume ?? {};
  try {
    const out = await runSteps({ ...automation, steps: res.steps ?? automation.steps }, doc ?? { title: automation.name, sections: [] },
      { stage: res.stage ?? null, at: res.at ?? null, ctx: { ...(res.ctx ?? {}), supabase, workspaceId, runId } },
      { startAt: run.step_index ?? 0, inputs: normalizeInputs(res.inputs, run.step_index),
        // Each item of the review decided on its own (GET-724); a plain approve approves them all.
        decisions: decisions ?? Object.fromEntries((st.bundle?.length ? st.bundle : [{ index: run.step_index ?? 0 }]).map(b => [b.index, { approve: true }])) });
    const row = runOutcome(out);
    // The steps before the pause keep their lines; the one approved and those after it add theirs.
    const before = (Array.isArray(run.step_log) ? run.step_log : []).filter(x => x?.status !== 'waiting');
    row.step_log = [...before, ...(out.log ?? []).filter(x => !before.some(b => b.step === x.step && b.status !== 'waiting'))]
      .map(x => (x.step === (st.preview?.step ? Number(String(st.preview.step).match(/Step (\d+)/)?.[1]) : -1) && x.status !== 'waiting' ? { ...x, approved_by: userId } : x));
    await supabase.from('agent_routine_runs').update(row).eq('id', runId);
    console.log(`[approvals] ${automation.name}: approved${who} → ${row.status}${out.delivered ? ` (${out.delivered})` : ''}`);
    return { ok: true, status: row.status, delivered: out.delivered ?? null, message: out.message ?? null };
  } catch (err) {
    await supabase.from('agent_routine_runs').update({ status: 'error', error: String(err?.message ?? err).slice(0, 500) }).eq('id', runId);
    return { ok: false, error: 'run_failed', message: String(err?.message ?? err).slice(0, 300) };
  }
}

/** A written document as something a person reads: an email's subject and body, or a brief's sections. Pure. */
export function documentOutput(d, { clip = 4000 } = {}) {
  if (!d) return null;
  const mail = emailParts(d);
  if (mail) return { kind: 'email', id: d.id, title: d.title ?? null, subject: mail.subject, body: mail.body.slice(0, clip) };
  const text = (d.sections ?? []).map(x => `${x.label}\n${x.body ?? ''}`.trim()).join('\n\n').replace(/\s*\[c[0-9a-z]{4}\]/g, '');
  return {
    kind: 'brief', id: d.id, title: d.title ?? null, headline: d.headline ?? null, text: text.slice(0, clip), sections: (d.sections ?? []).map(x => x.label),
    // Each section as its own block, so a page can lay the brief out with headings (GET-724).
    parts: (d.sections ?? []).map(x => ({ label: x.label, body: String(x.body ?? '').replace(/\s*\[c[0-9a-z]{4}\]/g, '').slice(0, 2500) })),
  };
}

/**
 * One run, step by step (GET-721): what each step did, its output (the summary, the email), where it
 * failed and why, what it waits for, and what it cost. The run's own page in History.
 */
export async function getAutomationRun(supabase, workspaceId, runId) {
  const { data: run } = await supabase.from('agent_routine_runs')
    .select('id, routine_id, status, error, started_at, step_index, state, step_log, document_id')
    .eq('workspace_id', workspaceId).eq('id', runId).maybeSingle();
  if (!run) return null;
  const { data: a } = await supabase.from('agent_routines').select('id, name, trigger_kind, steps').eq('id', run.routine_id).maybeSingle();
  const log = Array.isArray(run.step_log) ? run.step_log.filter(x => x && x.step != null) : [];
  const docIds = [...new Set([...log.map(x => x.document_id), run.document_id].filter(Boolean))];
  const { data: docs } = docIds.length ? await supabase.from('documents').select('id, title, headline, sections').in('id', docIds) : { data: [] };
  const byId = new Map((docs ?? []).map(d => [d.id, d]));
  const steps = log.length ? log : (run.document_id ? [{ step: 1, name: 'AI', status: 'ok', detail: 'Wrote it', document_id: run.document_id }] : []);
  return {
    id: run.id, status: run.status, error: run.error ?? null, started_at: run.started_at,
    automation: { id: run.routine_id, name: a?.name ?? 'Deleted automation', trigger: a?.trigger_kind ?? null },
    steps: steps.map(x => ({ ...x, output: x.document_id ? documentOutput(byId.get(x.document_id)) : null })),
    waiting: run.status === 'awaiting_approval' ? (run.state?.preview ?? null) : null,
    trigger: run.state?.trigger ?? null, test: !!run.state?.test,
  };
}

const MEETING_SOURCES = ['granola', 'fathom', 'fireflies', 'fellow', 'ringcentral', 'gong', 'zoom', 'otter', 'avoma', 'tldv'];

/**
 * The latest real trigger for a test (GET-724): the newest call from the recorders the trigger
 * listens to, or the newest matching account signal. Null when there is none to use.
 */
/**
 * The last real triggers an automation could be tested on (GET-735): its recorder's last calls (one
 * row per call, however many people were on it) or the last matching signals, newest first. The id
 * is what startTestRun takes to run on that one instead of the newest.
 */
export async function testTriggers(supabase, workspaceId, automation, { limit = 10 } = {}) {
  const kind = automation.trigger_kind;
  if (['clock', 'manual'].includes(kind) && flowRunsSteps(automation)) return [{ id: 'now', kind, label: 'Run it now', at: null, source: null, account: null }];
  if (kind === 'hubspot_field_changed') {
    // The last real changes of the watched field, in the last 7 days (GET-781).
    const cfg = automation.trigger_config ?? {};
    const r = await hubspotFieldChanges(supabase, workspaceId, cfg, { since: Date.now() - 7 * 86_400_000, cap: 2000, onlySet: true });
    return (r.ok ? r.changes : []).sort((x, y) => Date.parse(y.at) - Date.parse(x.at)).slice(0, limit).map(ch => ({
      id: `${ch.objectId}|${ch.at}`, kind, label: changeText(cfg, ch), at: ch.at, source: 'hubspot', account: ch.name ? { name: ch.name, domain: null } : null,
    }));
  }
  if (kind === 'call_ended') {
    const tools = (automation.trigger_config?.tools ?? automation.tools ?? []).map(t => String(t).toLowerCase());
    const { data: obs } = await supabase.from('observations').select('entity_id, source, observed_at, value, raw')
      .eq('workspace_id', workspaceId).eq('kind', 'event').eq('property', 'interaction.meeting_held')
      .in('source', tools.length ? tools : MEETING_SOURCES).order('observed_at', { ascending: false }).limit(limit * 8);
    const calls = new Map();
    for (const o of obs ?? []) {
      const id = `${o.source}|${o.observed_at}`;
      if (!calls.has(id)) calls.set(id, { id, kind, label: o.raw?.title ?? o.value?.title ?? 'A call', at: o.observed_at, source: o.source, people: [] });
      calls.get(id).people.push(o.entity_id);
    }
    const list = [...calls.values()].slice(0, limit);
    const ids = [...new Set(list.flatMap(c => c.people))];
    const { data: contacts } = ids.length ? await supabase.from('contacts').select('id, company_id').in('id', ids) : { data: [] };
    const coOf = new Map((contacts ?? []).map(c => [c.id, c.company_id]));
    const coIds = [...new Set((contacts ?? []).map(c => c.company_id).filter(Boolean))];
    const { data: cos } = coIds.length ? await supabase.from('companies').select('id, name, domain').in('id', coIds) : { data: [] };
    const co = new Map((cos ?? []).map(c => [c.id, c]));
    return list.map(({ people, ...c }) => {
      const a = people.map(p => co.get(coOf.get(p))).find(Boolean) ?? null;
      return { ...c, account: a ? { id: a.id, name: a.name ?? null, domain: a.domain ?? null } : null };
    });
  }
  if (kind === 'account_signal') {
    const kinds = automation.trigger_config?.signals ?? [];
    let q = supabase.from('account_signals').select('id, kind, content, title, occurred_at, account_id').eq('workspace_id', workspaceId).not('account_id', 'is', null).eq('team_readable', true);
    if (kinds.length) q = q.in('kind', kinds);
    const { data } = await q.order('occurred_at', { ascending: false }).limit(limit);
    const coIds = [...new Set((data ?? []).map(x => x.account_id))];
    const { data: cos } = coIds.length ? await supabase.from('companies').select('id, name, domain').in('id', coIds) : { data: [] };
    const co = new Map((cos ?? []).map(c => [c.id, c]));
    return (data ?? []).map(sig => ({
      id: sig.id, kind, label: `${SIGNAL_LABEL[sig.kind] ?? sig.kind}: ${sig.content ?? sig.title ?? ''}`.slice(0, 140), at: sig.occurred_at, source: null,
      account: co.get(sig.account_id) ? { id: sig.account_id, name: co.get(sig.account_id).name ?? null, domain: co.get(sig.account_id).domain ?? null } : null,
    }));
  }
  return [];
}

export async function latestTestTrigger(supabase, workspaceId, automation, pick = null) {
  const kind = automation.trigger_kind;
  if (kind === 'call_ended') {
    const tools = (automation.trigger_config?.tools ?? automation.tools ?? []).map(t => String(t).toLowerCase());
    // A chosen call (GET-735): "<source>|<observed_at>", one of testTriggers' ids.
    const [pickSource, pickAt] = typeof pick === 'string' && pick.includes('|') ? pick.split('|') : [null, null];
    let q = supabase.from('observations').select('entity_id, source, observed_at, value, raw')
      .eq('workspace_id', workspaceId).eq('kind', 'event').eq('property', 'interaction.meeting_held')
      .in('source', tools.length ? tools : MEETING_SOURCES);
    if (pickSource) q = q.eq('source', pickSource).eq('observed_at', pickAt);
    const { data: obs } = await q.order('observed_at', { ascending: false }).limit(1);
    const o = obs?.[0];
    if (!o) return null;
    const { data: sameCall } = await supabase.from('observations').select('entity_id')
      .eq('workspace_id', workspaceId).eq('property', 'interaction.meeting_held').eq('source', o.source).eq('observed_at', o.observed_at);
    const people = [...new Set((sameCall ?? []).map(x => x.entity_id))];
    const { data: contacts } = people.length ? await supabase.from('contacts').select('id, first_name, last_name, email, company_id').in('id', people) : { data: [] };
    const meeting = String(o.raw?.note_id ?? o.raw?.id ?? o.value?.meeting_id ?? o.raw?.meeting_id ?? '') || null;
    const title = o.raw?.title ?? o.value?.title ?? 'A call';
    const call = {
      meetingId: `test:${Date.now()}`, sourceMeetingId: meeting, title, occurredAt: o.observed_at, source: o.source,
      url: o.raw?.url ?? null, accountId: (contacts ?? []).find(c => c.company_id)?.company_id ?? null, personId: o.entity_id,
      attendees: (contacts ?? []).filter(c => c.email).map(c => ({ name: [c.first_name, c.last_name].filter(Boolean).join(' ') || null, email: c.email })),
      summary: o.value?.summary ?? null, transcript: null,
    };
    call.nextSteps = await loadCallNextSteps(supabase, workspaceId, meeting);
    return { kind, label: title, at: o.observed_at, source: o.source, entityId: call.accountId || call.personId, call };
  }
  if (kind === 'account_signal') {
    const kinds = automation.trigger_config?.signals ?? [];
    let q = supabase.from('account_signals').select('*').eq('workspace_id', workspaceId).not('account_id', 'is', null).eq('team_readable', true);
    if (kinds.length) q = q.in('kind', kinds);
    if (pick) q = q.eq('id', String(pick));
    const { data } = await q.order('occurred_at', { ascending: false }).limit(1);
    const sig = data?.[0];
    if (!sig) return null;
    return { kind, label: `${SIGNAL_LABEL[sig.kind] ?? sig.kind}: ${sig.content ?? sig.title ?? ''}`.slice(0, 140), at: sig.occurred_at, entityId: sig.account_id, signal: sig };
  }
  return null;
}

/**
 * Run an automation once, now, on its latest real trigger, and return at once with the run's id
 * (GET-724). The run goes on in the background and saves each step as it lands, so the canvas can
 * show it moving. It runs for real: drafts are drafted, and steps that need approval wait for it.
 */
/**
 * A scheduled flow's run (GET-772): "every day at 08:00" runs the canvas steps in order, with no
 * single account. Read steps read, the AI step writes from what they read, Slack posts it.
 * Returns the run row's patch (status, step_log, error).
 */
export async function runScheduledFlow(supabase, workspaceId, automation, { runId = null, onLog = null } = {}) {
  const out = await runSteps(automation, null, {
    stage: 'scheduled', at: new Date().toISOString(),
    ctx: { supabase, workspaceId, entityId: null, dealId: null, runId, writeAllInLoop: true, onLog },
  });
  return runOutcome(out);
}

/** Whether a scheduled automation runs its steps (GET-772): any step that is not the AI step itself. */
export function flowRunsSteps(automation) {
  const steps = Array.isArray(automation?.steps) ? automation.steps : [];
  return steps.some(st => st?.type && st.type !== 'agent');
}

export async function startTestRun(supabase, workspaceId, automationId, { pick = null } = {}) {
  const { data: a } = await supabase.from('agent_routines').select('*').eq('workspace_id', workspaceId).eq('id', automationId).maybeSingle();
  if (!a) return { ok: false, error: 'not_found' };
  // A field change tests on one of the last real changes (GET-781).
  if (a.trigger_kind === 'hubspot_field_changed') {
    const cfg = a.trigger_config ?? {};
    const r = await hubspotFieldChanges(supabase, workspaceId, cfg, { since: Date.now() - 7 * 86_400_000, cap: 2000, onlySet: true });
    const all = (r.ok ? r.changes : []).sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
    const ch = pick ? all.find(c => `${c.objectId}|${c.at}` === pick) : all[0];
    if (!ch) return { ok: false, error: 'no_trigger', message: r.ok ? 'That field has not changed in HubSpot in the last 7 days.' : (REASON_TEXT[r.reason] ?? r.reason) };
    const trig = { kind: 'hubspot_field_changed', label: changeText(cfg, ch), at: ch.at, source: 'hubspot' };
    const { data: run, error } = await supabase.from('agent_routine_runs').insert({
      workspace_id: workspaceId, routine_id: a.id, dedupe_key: `test:${a.id}:${Date.now()}`, status: 'running', state: { test: true, trigger: trig },
    }).select('id').single();
    if (error) return { ok: false, error: 'run_not_created', message: error.message };
    const save = (patch) => supabase.from('agent_routine_runs').update(patch).eq('id', run.id).then(() => null, () => null);
    (async () => {
      await runFieldChangeAutomation(supabase, workspaceId, a, ch, { test: true, runId: run.id, onLog: (log) => save({ step_log: log }) });
      const { data: row } = await supabase.from('agent_routine_runs').select('state').eq('id', run.id).maybeSingle();
      await save({ state: { ...(row?.state ?? {}), test: true, trigger: trig } });
    })();
    return { ok: true, run_id: run.id, trigger: trig };
  }
  // A schedule tests by running now (GET-772): nothing to pick, no account.
  const scheduled = ['clock', 'manual'].includes(a.trigger_kind) && flowRunsSteps(a);
  const trigger = scheduled ? { kind: a.trigger_kind, label: 'Run now', at: new Date().toISOString(), source: null } : await latestTestTrigger(supabase, workspaceId, a, pick);
  if (!trigger) return { ok: false, error: 'no_trigger', message: a.trigger_kind === 'call_ended' ? 'No call from this recorder yet to test with.' : a.trigger_kind === 'account_signal' ? 'No matching account signal yet to test with.' : 'Testing on a live trigger works for calls and account signals.' };
  const { data: run, error } = await supabase.from('agent_routine_runs').insert({
    workspace_id: workspaceId, routine_id: a.id, dedupe_key: `test:${a.id}:${Date.now()}`, status: 'running',
    state: { test: true, trigger: { kind: trigger.kind, label: trigger.label, at: trigger.at, source: trigger.source ?? null } },
  }).select('id').single();
  if (error) return { ok: false, error: 'run_not_created', message: error.message };
  const runId = run.id;
  const save = (patch) => supabase.from('agent_routine_runs').update(patch).eq('id', runId).then(() => null, () => null);
  (async () => {
    try {
      if (scheduled) {
        const row = await runScheduledFlow(supabase, workspaceId, a, { runId, onLog: (log) => save({ step_log: log }) });
        await save({ ...row, state: { ...(row.state ?? {}), test: true, trigger: { kind: trigger.kind, label: trigger.label, at: trigger.at, source: null } } });
        await supabase.from('agent_routines').update({ last_run_at: new Date().toISOString() }).eq('id', a.id);
        return;
      }
      const agentCfg = (Array.isArray(a.steps) ? a.steps : []).find(st => st?.type === 'agent')?.config ?? {};
      const stage = trigger.kind === 'call_ended' ? 'call_ended' : (trigger.signal?.kind ?? 'automation');
      const doc = await makeArtifact(supabase, workspaceId, {
        artifact: a.artifact, entityId: agentCfg.account_id || trigger.entityId, stage, prompt: a.prompt,
        context: agentCfg.context ?? null, call: trigger.call ?? null, signal: trigger.signal ?? null,
        runId, agentStep: agentStepOf(a), format: formatOf(a),
      });
      await save({ document_id: doc.id });
      const out = await deliver(a, doc, {
        stage, at: trigger.at,
        ctx: { supabase, workspaceId, entityId: trigger.entityId, dealId: null, call: trigger.call ?? null, signal: trigger.signal ?? null, runId,
          onLog: (log) => save({ step_log: log }) },
      });
      const row = runOutcome(out);
      await save({ ...row, state: { ...(row.state ?? {}), test: true, trigger: { kind: trigger.kind, label: trigger.label, at: trigger.at, source: trigger.source ?? null } } });
      await supabase.from('agent_routines').update({ last_run_at: new Date().toISOString() }).eq('id', a.id);
    } catch (err) {
      await save({ status: 'error', error: String(err?.message ?? err).slice(0, 500) });
    }
  })();
  return { ok: true, run_id: runId, trigger: { kind: trigger.kind, label: trigger.label, at: trigger.at, source: trigger.source ?? null } };
}

/** Saved AI fields by step index; runs paused before GET-724 kept one set for the paused step. */
function normalizeInputs(inputs, index) {
  if (!inputs) return null;
  if (Array.isArray(inputs.properties)) return { [index ?? 0]: { properties: inputs.properties } };
  return inputs;
}

/** Runs waiting on someone, newest first, with what each would do (GET-713). */
/** A run paused before GET-724 kept its HubSpot tasks only as text rows: give them back as tasks,
 *  keyed the way the runner reads `decisions.tasks`, so each one is still approved on its own. */
/**
 * Send an email a run already drafted (GET-731): the reviewer edits it in Approvals and sends it,
 * from the mailbox the draft is in; the draft it replaces is removed so nothing goes out twice.
 * A run from before mailboxes were recorded sends from the automation owner's Gmail, and its old
 * draft stays in Drafts (we never knew its id).
 */
// ── An approval the reviewer already finished (GET-834) ─────────────────────
// A run that drafted an email into Gmail and then paused to approve sending it shows that draft
// with its own Send button. Sending from there sent the email, but the run's pending item stayed
// undecided, so the approval sat in the list after its email had gone. When everything a paused
// run waits on is an email and one of its emails has been sent, there is nothing left to decide.
const EMAIL_STEP_TYPES = new Set(['email', 'gmail', '__followup_draft']);
const pendingItemsOf = (state, stepIndex = 0) => (state?.bundle?.length ? state.bundle : (state?.preview ? [{ index: stepIndex, ...state.preview }] : []));

/** True when a paused run waits only on email sends and one of its emails already went out. Pure. */
export function approvalAlreadyDone(run) {
  const items = pendingItemsOf(run?.state, run?.step_index ?? 0);
  if (!items.length || !items.every((it) => it?.email || EMAIL_STEP_TYPES.has(it?.type))) return false;
  return (Array.isArray(run?.step_log) ? run.step_log : []).some((x) => x?.mail?.kind === 'sent');
}

export async function sendRunEmail(supabase, workspaceId, runId, { step, to, cc = null, subject, body, userId = null, connectionId = null }) {
  const send = STEP_HANDLERS.gmail_send;
  if (!send) return { ok: false, error: 'send_not_available_here' };
  if (!String(to ?? '').includes('@')) return { ok: false, error: 'no_recipient', message: 'Add who it goes to.' };
  if (!String(body ?? '').trim()) return { ok: false, error: 'empty', message: 'The email is empty.' };
  const { data: run } = await supabase.from('agent_routine_runs').select('id, routine_id, step_log, status, state, step_index')
    .eq('workspace_id', workspaceId).eq('id', runId).maybeSingle();
  if (!run) return { ok: false, error: 'not_found' };
  const log = Array.isArray(run.step_log) ? run.step_log : [];
  const at = log.findIndex(x => x?.step === Number(step));
  if (at < 0) return { ok: false, error: 'no_such_step' };
  const line = log[at];
  if (line.mail?.kind === 'sent') return { ok: false, error: 'already_sent', message: 'This email was already sent.' };
  const { data: a } = await supabase.from('agent_routines').select('user_id').eq('id', run.routine_id).maybeSingle();
  const mail = line.mail ?? {};
  const r = await send({ supabase, workspaceId, userId: connectionId ? userId : (mail.user_id ?? a?.user_id ?? userId), connectionId: connectionId ?? mail.connection_id ?? null,
    to: String(to).trim(), cc: cc ? String(cc).trim() || null : null, subject: String(subject ?? '').trim() || 'Following up', body: String(body).trim() })
    .catch(e => ({ status: 'failed', message: e.message }));
  if (r?.status !== 'sent') return { ok: false, error: r?.error ?? r?.status ?? 'failed', message: r?.message ?? (r?.status === 'no_gmail' ? 'No Gmail is connected for this mailbox.' : 'Gmail did not send it.') };
  if (mail.draft_id && STEP_HANDLERS.gmail_delete_draft) {
    await STEP_HANDLERS.gmail_delete_draft({ supabase, workspaceId, userId: mail.user_id ?? a?.user_id ?? userId, connectionId: mail.connection_id ?? null, draftId: mail.draft_id }).catch(() => null);
  }
  const next = log.slice();
  next[at] = { ...line, detail: [String(line.detail ?? '').replace(/\s*·?\s*Draft in Gmail(?: \([^)]*\))?/, ''), `Sent from Gmail${r.mailbox ? ` (${r.mailbox})` : ''}`].filter(Boolean).join(' · '),
    mail: { ...mail, kind: 'sent', draft_id: null, mailbox: r.mailbox ?? mail.mailbox ?? null, to, cc, subject, body, sent_at: new Date().toISOString(), sent_by: userId } };
  // The send was the decision the run was waiting on: close it rather than leave it in Approvals.
  const finished = run.status === 'awaiting_approval' && approvalAlreadyDone({ ...run, step_log: next });
  await supabase.from('agent_routine_runs').update({ step_log: next,
    ...(finished ? { status: 'ok', finished_at: new Date().toISOString(), state: { ...(run.state ?? {}), resolved: 'sent_from_draft' } } : {}) }).eq('id', run.id);
  return { ok: true, mailbox: r.mailbox ?? null, finished };
}

/**
 * A review half done (GET-735): each item's Approve or Skip as the reviewer clicks it, kept on the
 * paused run so a reload shows the skipped task struck through instead of asking again. Nothing
 * runs until the last item is decided (decideAutomationRun). `choices` = { "<entry key>": "approve" | "skip" },
 * `send` = { key: true } for an email to send, `edits` = { key: { to, cc, subject, body } }.
 */
export async function saveApprovalChoices(supabase, workspaceId, runId, { choices = {}, send = {}, edits = {} } = {}) {
  const { data: run } = await supabase.from('agent_routine_runs').select('id, status, state')
    .eq('workspace_id', workspaceId).eq('id', runId).maybeSingle();
  if (!run) return { ok: false, error: 'not_found' };
  if (run.status !== 'awaiting_approval') return { ok: false, error: 'not_waiting' };
  const clean = (o, ok) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([k, v]) => /^[\w:]{1,40}$/.test(k) && ok(v)).slice(0, 100));
  const partial = {
    choices: clean(choices, v => v === 'approve' || v === 'skip'),
    send: clean(send, v => v === true),
    edits: clean(edits, v => v && typeof v === 'object'),
    at: new Date().toISOString(),
  };
  partial.edits = Object.fromEntries(Object.entries(partial.edits).map(([k, v]) => [k, {
    to: String(v.to ?? '').slice(0, 2000), cc: String(v.cc ?? '').slice(0, 2000), subject: String(v.subject ?? '').slice(0, 500), body: String(v.body ?? '').slice(0, 20000),
  }]));
  await supabase.from('agent_routine_runs').update({ state: { ...(run.state ?? {}), partial } }).eq('id', run.id).eq('status', 'awaiting_approval');
  return { ok: true };
}

export function withTasks(items, ctx) {
  return items.map(it => {
    if (it?.type !== 'hubspot' || it.tasks || !(it.rows ?? []).some(r => r?.label === 'Tasks')) return it;
    const owed = (ctx?.call?.nextSteps ?? []).filter(x => !x.theirs);
    return owed.length ? { ...it, action: it.action ?? 'task', tasks: owed.map((x, k) => ({ key: k, title: x.title, due_at: x.due_at ?? null })) } : it;
  });
}

export async function listAutomationApprovals(supabase, workspaceId, { limit = 100 } = {}) {
  const { data: waiting } = await supabase.from('agent_routine_runs')
    .select('id, routine_id, started_at, step_index, state, document_id, step_log')
    .eq('workspace_id', workspaceId).eq('status', 'awaiting_approval')
    .order('started_at', { ascending: false }).limit(limit);
  // One whose email was already sent from its draft is done, whatever its status still says (GET-834).
  const runs = (waiting ?? []).filter((r) => !approvalAlreadyDone(r));
  const ids = [...new Set((runs ?? []).map(r => r.routine_id))];
  const { data: autos } = ids.length ? await supabase.from('agent_routines').select('id, name, trigger_kind').in('id', ids) : { data: [] };
  const byId = new Map((autos ?? []).map(a => [a.id, a]));
  const accountIds = [...new Set((runs ?? []).map(r => r.state?.resume?.ctx?.entityId).filter(Boolean))];
  const { data: cos } = accountIds.length ? await supabase.from('companies').select('id, name, domain').in('id', accountIds) : { data: [] };
  const coById = new Map((cos ?? []).map(c => [c.id, c]));
  // What the run already wrote before it paused (GET-721): the summary, the email, shown with the ask.
  const outIds = [...new Set((runs ?? []).flatMap(r => (Array.isArray(r.step_log) ? r.step_log : []).map(x => x?.document_id)).filter(Boolean))];
  const { data: outDocs } = outIds.length ? await supabase.from('documents').select('id, title, headline, sections').in('id', outIds) : { data: [] };
  const docById = new Map((outDocs ?? []).map(d => [d.id, d]));
  return (runs ?? []).map(r => {
    const a = byId.get(r.routine_id);
    const ctx = r.state?.resume?.ctx ?? {};
    const co = ctx.entityId ? coById.get(ctx.entityId) : null;
    return {
      run_id: r.id, requested_at: r.started_at,
      automation: { id: r.routine_id, name: a?.name ?? 'Automation', trigger: a?.trigger_kind ?? null },
      account: co ? { id: co.id, name: co.name ?? null, domain: co.domain ?? null } : (ctx.entityId ? { id: ctx.entityId, name: null, domain: null } : null),
      why: ctx.signal ? (ctx.signal.content ?? ctx.signal.title ?? null) : ctx.call ? `After the call${ctx.call.title ? `: ${ctx.call.title}` : ''}` : null,
      step: r.state?.preview?.step ?? null, type: r.state?.preview?.type ?? null, rows: r.state?.preview?.rows ?? [],
      // Everything this run waits on, each decided on its own (GET-724).
      items: withTasks(r.state?.bundle?.length ? r.state.bundle : (r.state?.preview ? [{ index: r.step_index ?? 0, ...r.state.preview }] : []), ctx),
      // The notetaker the call came from (granola, fathom…), for its logo on the summary (GET-729).
      source: r.state?.trigger?.source ?? ctx.call?.source ?? null,
      document_id: r.document_id ?? null, done_before: r.state?.done ?? null,
      earlier: (Array.isArray(r.step_log) ? r.step_log : []).filter(x => x?.status === 'ok')
        .map(x => ({ step: x.step, name: x.name, detail: x.detail ?? null, mail: x.mail ? { kind: x.mail.kind, mailbox: x.mail.mailbox ?? null, to: x.mail.to ?? null, cc: x.mail.cc ?? null } : null,
          output: x.document_id ? documentOutput(docById.get(x.document_id), { clip: 6000 }) : null })),
      // Who a follow-up goes to when the run did not record it: the people on the call (GET-731).
      call_to: (ctx.call?.attendees ?? []).map(p => p?.email).filter(Boolean).join(', ') || null,
      // What the reviewer already decided before a reload (GET-735).
      partial: r.state?.partial ?? null,
    };
  });
}

/** A run's row from what delivery said: failed with the step and why, or done (with why it stopped, if it did). */
function runOutcome({ delivered, reason, failed, message, paused, index, preview, bundle, resume, log }) {
  const step_log = Array.isArray(log) ? log : undefined;
  if (paused) return { status: 'awaiting_approval', step_index: index, state: { preview, bundle: bundle ?? (preview ? [preview] : []), resume, done: delivered ?? null }, error: null, ...(step_log ? { step_log } : {}) };
  if (failed) return { status: 'error', error: message ?? reason ?? 'Failed', ...(step_log ? { step_log } : {}) };
  return { status: 'ok', error: delivered ? null : (message ?? reason ?? null), ...(step_log ? { step_log } : {}) };
}

async function deliver(automation, doc, opts = {}) {
  if (Array.isArray(automation.steps) && automation.steps.length) return runSteps(automation, doc, opts);
  return deliverLegacy(automation, doc, opts);
}

async function deliverLegacy(automation, doc, { stage = null, at = null, ctx = null } = {}) {
  const dest = automation.destination ?? 'none';
  if (dest === 'none' || !automation.destination_target) return { delivered: null };
  if (dest === 'email') {
    const mail = await composeAutomationEmail(automation, doc, { stage, at, ctx });
    if (!mail.to) return { delivered: null };
    const pdf = mail.attach ? await renderDocumentPdf(doc, { writtenAt: doc.created_at ?? new Date() }) : null;
    const res = await sendEmail({
      to: mail.to, cc: mail.cc.length ? mail.cc : undefined,
      subject: mail.subject, text: mail.text, html: mail.html,
      attachments: pdf ? [{ filename: mail.filename, content: pdf.toString('base64') }] : undefined,
      tag: 'AUTOMATION',
    });
    return { delivered: res.sent ? `email:${mail.to}${mail.cc.length ? ` +${mail.cc.length} cc` : ''}` : null, reason: res.reason };
  }

  if (dest === 'webhook') {
    await fetch(automation.destination_target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: doc.title, headline: doc.headline, document_id: doc.id }),
    });
    return { delivered: 'webhook' };
  }
  // Slack has no sender here yet; the run still records, and Home still has the document.
  return { delivered: null, reason: 'destination_not_wired' };
}

/** One workspace's automations against one day of stage changes. */
export async function runAutomationsForWorkspace(supabase, workspaceId, since, { onlyAccount = null, onlyAutomation = null, max = null } = {}) {
  const { data: routines } = await supabase
    .from('agent_routines')
    .select('*')
    .eq('workspace_id', workspaceId)
    // A TEST RUN IGNORES THE SWITCH. You set one up, you want to see it work, and being
    // told to enable it first — on a schedule that next fires tomorrow — is not an answer.
    .or(onlyAutomation ? `id.eq.${onlyAutomation},enabled.eq.true` : 'enabled.eq.true');
  const dealAutomations = (routines ?? []).filter(r =>
    EVENT_TRIGGERS.includes(r.trigger_kind)
    && (!onlyAutomation || r.id === onlyAutomation));
  if (!dealAutomations.length) return { ran: 0, skipped: 0 };

  // A TEST SHOWS YOU THE MOST RECENT DEAL, not the oldest one still inside the window.
  // The window is ordered oldest-first so the daily pass works through a backlog in the
  // order things happened; a test taking max:1 off the front of that list handed back
  // whatever closed ninety days ago. You are testing the automation, so you want to see it
  // on the deal you just closed.
  // BOTH TRIGGERS NOW RUN ON A REAL DATE. Won and lost come from deal_outcomes.closed_at,
  // the date the CRM recorded. A bare stage move comes from the observation that actually
  // changed the value — deal_outcomes only records endings, so it cannot answer "moved to
  // negotiation", but the append-only observation history can, and it carries the date.
  const newestFirst = Boolean(onlyAutomation);
  // WE LEARN THAT A DEAL CLOSED LONG AFTER IT CLOSED, so a window on the close date finds
  // nothing. deal_outcomes is a derived ledger: one account closed on a Thursday and was derived
  // the following Tuesday, and across the most recently derived wins NOT ONE has a closed_at inside
  // 26 hours of being derived — nearly all of them lag by over a month. A 26-hour window on
  // closed_at is a trigger that can never fire, which is what the first version of this fix
  // shipped: it stopped writing up deals from last April by never writing up anything.
  //
  // So the outcome triggers look at every closed deal, and two things decide what fires:
  // the automation's own created_at (below) and the dedupe key, which is permanent. Cheap:
  // one query over a few hundred accounts.
  // THE DAILY PASS READS FROM THE OLDEST AUTOMATION'S BIRTH, not from 1970. A deal that
  // closed before an automation existed is skipped below anyway, so reading them was only
  // ever cost — and reading all of them is what hit the row cap and hid every new deal.
  const outcomeBirths = dealAutomations.filter(a => a.trigger_kind === 'deal_closed_won' || a.trigger_kind === 'deal_closed_lost')
    .map(a => a.created_at).filter(Boolean).sort();
  const EPOCH = outcomeBirths[0] ?? new Date(0).toISOString();
  const wantsStageMoves = dealAutomations.some(a => a.trigger_kind === 'deal_stage_changed');
  const wantsOutcomes = dealAutomations.some(a => a.trigger_kind === 'deal_closed_won' || a.trigger_kind === 'deal_closed_lost');
  const wantsIcp = dealAutomations.some(a => a.trigger_kind === 'icp_tier_changed');
  let changes = [
    // A test keeps its 90-day window so it has something recent to show; the daily pass takes
    // the lot and lets created_at and the dedupe decide.
    ...(wantsOutcomes ? await closedDeals(supabase, workspaceId, onlyAutomation ? since : EPOCH, { newestFirst }) : []),
    ...(wantsStageMoves ? await changedAccounts(supabase, workspaceId, since, { newestFirst }) : []),
    ...(wantsIcp ? await icpTierChanges(supabase, workspaceId, since, { newestFirst }) : []),
  ];
  // A test runs against ONE account. The first version of this had no such switch and its
  // first outing wrote hundreds of documents, which is a thing you find out afterwards.
  if (onlyAccount) changes = changes.filter(c => c.entityId === onlyAccount);
  let ran = 0;
  for (const change of changes) {
    if (ran >= (max ?? MAX_RUNS_PER_PASS)) {
      console.warn(`[automations] stopping at ${MAX_RUNS_PER_PASS} runs — ${changes.length} changes in this window looks like a recompute, not a day's news`);
      break;
    }
    for (const a of dealAutomations) {
      // deal_stage_changed catches every deal move; the won/lost ones only their own; an ICP
      // automation only ICP moves, and no deal automation an ICP one.
      if (change.trigger === 'icp_tier_changed' ? a.trigger_kind !== 'icp_tier_changed'
        : (a.trigger_kind !== 'deal_stage_changed' && a.trigger_kind !== change.trigger)) continue;
      // A DEAL THAT CLOSED BEFORE THIS AUTOMATION EXISTED IS NOT NEWS FOR IT. This is what
      // keeps the back catalogue quiet without a seeding pass: hundreds of wins closed before you
      // set the thing up, and every one of them fails this line. A test ignores it, because
      // nothing may have closed since you created it and you still want to see the output.
      if (!onlyAutomation && a.created_at && change.at && String(change.at) < String(a.created_at)) continue;
      // ONE RUN PER AUTOMATION, PER ACCOUNT, PER STAGE — FOREVER. No date in the key.
      //
      // This is the actual cause of the flood. The key used to carry the day, so a nightly
      // recompute produced a new key for a deal that had been closed-won for months and the
      // automation fired again, and again the night after. A deal is won once; writing it up
      // is a thing that happens once. Moving to a new stage is a new key and fires properly.
      const dedupe = change.dedupe ? `${a.id}:${change.dedupe}` : `${a.id}:${change.entityId}:${change.stage}`;
      // A test may repeat itself; the daily pass may not.
      if (!onlyAutomation) {
        const { data: seen } = await supabase.from('agent_routine_runs')
          .select('id').eq('routine_id', a.id).eq('dedupe_key', dedupe).maybeSingle();
        if (seen) continue;
      }

      const { data: run } = await supabase.from('agent_routine_runs').insert({
        workspace_id: workspaceId, routine_id: a.id, dedupe_key: dedupe, status: 'running',
      }).select('id').single();

      try {
        // The AI step's own settings (GET-568): which account it reads, and which parts.
        const agentCfg = (Array.isArray(a.steps) ? a.steps : []).find(s => s?.type === 'agent')?.config ?? {};
        const doc = await makeArtifact(supabase, workspaceId, {
          artifact: a.artifact, entityId: agentCfg.account_id || change.entityId, stage: change.stage, prompt: a.prompt,
          context: agentCfg.context ?? null, runId: run?.id ?? null, agentStep: agentStepOf(a), format: formatOf(a),
        });
        // A TEST SENDS. You are testing whether the automation works, and sending is half
        // of what it does — a test that skips delivery tells you the writer is fine and
        // leaves the part that touches somebody else's inbox unproven.
        const out = await deliver(a, doc, {
          stage: change.stage, at: change.at,
          ctx: { supabase, workspaceId, entityId: change.entityId, dealId: change.dealId ?? null, runId: run?.id ?? null },
        });
        const { delivered } = out;
        await supabase.from('agent_routine_runs').update({ ...runOutcome(out), document_id: doc.id }).eq('id', run?.id);
        await supabase.from('agent_routines').update({ last_run_at: new Date().toISOString() }).eq('id', a.id);
        ran++;
        console.log(`[automations] ${a.name} → ${doc.title}${delivered ? ` → ${delivered}` : ''}`);
        if (onlyAutomation) return { ran: 1, changes: changes.length, document: doc };
      } catch (err) {
        // A failed run is recorded, not swallowed: History is the only place somebody can
        // find out an automation has been failing every night.
        await supabase.from('agent_routine_runs').update({ status: 'error', error: String(err?.message ?? err).slice(0, 500) }).eq('id', run?.id);
        console.error(`[automations] ${a.name} failed:`, err?.message ?? err);
      }
    }
  }
  return { ran, changes: changes.length };
}

/** The daily pass, across every workspace that has an event automation enabled. */
export async function runAutomationDailyPoll({ sinceHours = 26, onlyAccount = null, onlyWorkspace = null } = {}) {
  const supabase = getSupabaseClient();
  // 26 hours, not 24: a poll that looks back exactly as far as its own period drops
  // anything that lands while it is running, and a duplicate is already impossible.
  const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();
  const { data: rows } = await supabase.from('agent_routines')
    .select('workspace_id')
    .eq('enabled', true)
    .in('trigger_kind', EVENT_TRIGGERS);
  const workspaces = [...new Set((rows ?? []).map(r => r.workspace_id))]
    .filter(ws => !onlyWorkspace || ws === onlyWorkspace);
  if (!workspaces.length) return;
  console.log(`[automations] daily poll — ${workspaces.length} workspace(s) since ${since}`);
  for (const ws of workspaces) {
    try {
      const { ran, changes } = await runAutomationsForWorkspace(supabase, ws, since, { onlyAccount });
      console.log(`[automations] ${ws}: ${changes ?? 0} stage change(s), ${ran} run(s)`);
    } catch (err) {
      console.error(`[automations] ${ws} failed:`, err?.message ?? err);
    }
  }
}

// ── Deal events (GET-559) ────────────────────────────────────────────────────
//
// The same two readers the deal automations use, pushed out as record events to the workspaces
// that subscribed to them. Hourly, not daily: a close reaches deal_outcomes when the ledger
// rebuilds, and a stage move as soon as the CRM sync observes it, so the hour after either is
// when it is news. The dedupe key is permanent, so re-reading the same close every hour queues
// it once.
const DEAL_EVENTS = ['deal.won', 'deal.lost', 'deal.stage_changed'];
const CLOSE_WINDOW_DAYS = 45;     // the ledger learns of a close weeks late (see closedDeals)

export async function emitDealEventsPoll({ stageSinceHours = 3, onlyWorkspace = null } = {}) {
  const supabase = getSupabaseClient();
  const workspaces = (await workspacesSubscribedTo(supabase, DEAL_EVENTS))
    .filter(ws => !onlyWorkspace || ws === onlyWorkspace);
  for (const ws of workspaces) {
    let queued = 0;
    try {
      const closeSince = new Date(Date.now() - CLOSE_WINDOW_DAYS * 86_400_000).toISOString();
      for (const c of await closedDeals(supabase, ws, closeSince, { newestFirst: true })) {
        const won = c.stage === 'closed_won';
        queued += await emitEvent(supabase, {
          workspaceId: ws, type: won ? 'deal.won' : 'deal.lost',
          accountId: c.entityId, dealId: c.dealId ?? null, occurredAt: c.at,
          maxAgeHours: CLOSE_WINDOW_DAYS * 24,
          dedupeKey: `${c.dealId ?? c.entityId}:${c.stage}`,
          data: { outcome: won ? 'won' : 'lost', closed_at: c.at, deal_id: c.dealId ?? null },
        });
      }
      const stageSince = new Date(Date.now() - stageSinceHours * 3_600_000).toISOString();
      for (const m of await changedAccounts(supabase, ws, stageSince, { newestFirst: true })) {
        queued += await emitEvent(supabase, {
          workspaceId: ws, type: 'deal.stage_changed', accountId: m.entityId, occurredAt: m.at,
          dedupeKey: `${m.entityId}:${m.stage}:${String(m.at).slice(0, 10)}`,
          data: { stage: m.stage, changed_at: m.at },
        });
      }
      if (queued) console.log(`[events] ${ws}: ${queued} deal event deliver(ies) queued`);
    } catch (err) {
      console.error(`[events] deal events for ${ws} failed:`, err?.message ?? err);
    }
  }
}

// ── ICP events (GET-588) ─────────────────────────────────────────────────────
//
// icp.score_changed whenever an account's score moves (or it is scored for the first time), and
// icp.tier_changed when the move crosses a tier. Hourly, from the same reader the ICP automation
// uses; the dedupe key is the prediction and the moment it moved, so a re-read never re-sends.
const ICP_EVENTS = ['icp.score_changed', 'icp.tier_changed'];

export async function emitIcpEventsPoll({ sinceHours = 3, onlyWorkspace = null } = {}) {
  const supabase = getSupabaseClient();
  const workspaces = (await workspacesSubscribedTo(supabase, ICP_EVENTS))
    .filter(ws => !onlyWorkspace || ws === onlyWorkspace);
  const since = new Date(Date.now() - sinceHours * 3_600_000).toISOString();
  for (const ws of workspaces) {
    let queued = 0;
    try {
      for (const c of await icpChanges(supabase, ws, since)) {
        const data = {
          from: c.from, to: c.to, first: c.first,
          scorer: c.scorer, reason: c.reason, person_id: c.personId, changed_at: c.at,
        };
        const base = { workspaceId: ws, personId: c.personId, accountId: c.accountId, occurredAt: c.at, data };
        queued += await emitEvent(supabase, { ...base, type: 'icp.score_changed', dedupeKey: `${c.predictionId}:${c.at}` });
        if (c.first || c.from?.tier !== c.to.tier) {
          queued += await emitEvent(supabase, { ...base, type: 'icp.tier_changed', dedupeKey: `${c.predictionId}:${c.at}` });
        }
      }
      if (queued) console.log(`[events] ${ws}: ${queued} ICP event deliver(ies) queued`);
    } catch (err) {
      console.error(`[events] ICP events for ${ws} failed:`, err?.message ?? err);
    }
  }
}

// ── People added (GET-588) ───────────────────────────────────────────────────
//
// One event per workspace per hour with the people created in it, never one per person: a backfill
// or a CRM import lands thousands at once. Team members are left out (they are not the market).
// The dedupe key is the hour, so a re-run of the same hour sends nothing twice.
const PEOPLE_ADDED_IDS = 100;

export async function emitPeopleAddedPoll({ now = Date.now(), onlyWorkspace = null } = {}) {
  const supabase = getSupabaseClient();
  const workspaces = (await workspacesSubscribedTo(supabase, ['people.added']))
    .filter(ws => !onlyWorkspace || ws === onlyWorkspace);
  if (!workspaces.length) return;
  // The last full hour: [hh-1:00, hh:00).
  const until = new Date(Math.floor(now / 3_600_000) * 3_600_000);
  const since = new Date(until.getTime() - 3_600_000);
  for (const ws of workspaces) {
    try {
      const { data: rows, count, error } = await supabase.from('entities')
        .select('id', { count: 'exact' })
        .eq('workspace_id', ws).eq('type', 'person').eq('status', 'active')
        .gte('created_at', since.toISOString()).lt('created_at', until.toISOString())
        .order('created_at', { ascending: true })
        .limit(PEOPLE_ADDED_IDS * 3);
      if (error) throw new Error(error.message);
      if (!rows?.length) continue;
      const internal = await getInternalEntityIds(supabase, ws).catch(() => new Set());
      const ids = rows.map(r => r.id).filter(id => !internal.has(id));
      if (!ids.length) continue;
      const total = Math.max((count ?? rows.length) - (rows.length - ids.length), ids.length);
      const queued = await emitEvent(supabase, {
        workspaceId: ws, type: 'people.added', occurredAt: until.toISOString(),
        dedupeKey: since.toISOString(),
        data: { count: total, person_ids: ids.slice(0, PEOPLE_ADDED_IDS), more: total > PEOPLE_ADDED_IDS, since: since.toISOString(), until: until.toISOString() },
      });
      if (queued) console.log(`[events] ${ws}: people.added (${total}) queued`);
    } catch (err) {
      console.error(`[events] people.added for ${ws} failed:`, err?.message ?? err);
    }
  }
}

// ── Preview (GET-566) ────────────────────────────────────────────────────────
//
// The editor shows a field with its variables filled in, from a real trigger: the deal that
// closed most recently, or one of the few before it. The values come from templateVars — the
// same reads a run makes — so what the preview says is what the email will say.
const PREVIEW_SAMPLES = 6;
const AI_PLACEHOLDER = '[The AI step writes this when the automation runs. Run a test to see a real one.]';

async function previewSamples(supabase, workspaceId, when) {
  const outcome = when === 'deal_closed_lost' ? 'lost' : when === 'deal_closed_won' || when === 'deal_stage_changed' ? 'won' : null;
  let rows = [];
  if (outcome) {
    const { data } = await supabase.from('deal_outcomes').select('entity_id, deal_id, closed_at')
      .eq('workspace_id', workspaceId).eq('outcome', outcome)
      .order('closed_at', { ascending: false }).limit(PREVIEW_SAMPLES * 3);
    const seen = new Set();
    for (const d of data ?? []) {
      if (!d.entity_id || seen.has(d.entity_id)) continue;
      seen.add(d.entity_id);
      rows.push({ entity_id: d.entity_id, deal_id: d.deal_id ?? null, at: d.closed_at });
      if (rows.length >= PREVIEW_SAMPLES) break;
    }
  } else {
    const { data } = await supabase.from('entity_list_rows').select('entity_id, last_activity_at')
      .eq('workspace_id', workspaceId).eq('kind', 'account')
      .order('last_activity_at', { ascending: false, nullsFirst: false }).limit(PREVIEW_SAMPLES);
    rows = (data ?? []).map(r => ({ entity_id: r.entity_id, deal_id: null, at: r.last_activity_at }));
  }
  if (!rows.length) return [];
  const { data: names } = await supabase.from('entity_list_rows').select('entity_id, name')
    .eq('workspace_id', workspaceId).in('entity_id', rows.map(r => r.entity_id));
  const nameOf = new Map((names ?? []).map(n => [n.entity_id, n.name]));
  return rows.map(r => ({ ...r, name: nameOf.get(r.entity_id) ?? 'Unnamed account' }));
}

/**
 * The variables a flow would fill, against one real sample. `sample` picks among the recent
 * ones by account id; without it, the most recent. The AI step's output is the account's latest
 * written document when there is one, else a placeholder that says so.
 */
export async function previewAutomationVars(supabase, workspaceId, { when, steps = [], entityId = null } = {}) {
  const samples = await previewSamples(supabase, workspaceId, when);
  const pick = (entityId && samples.find(x => x.entity_id === entityId)) || samples[0] || null;
  if (!pick) return { samples, sample: null, vars: {} };
  const { data: doc } = await supabase.from('documents')
    .select('id, title, headline, sections, created_at')
    .eq('workspace_id', workspaceId).eq('subject_entity_id', pick.entity_id).is('deleted_at', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  const stage = when === 'deal_closed_won' ? 'closed_won' : when === 'deal_closed_lost' ? 'closed_lost' : null;
  // Every text in the flow, so the HubSpot fields any of them names are read once.
  const texts = steps.flatMap(s => Object.values(s?.config ?? {}).filter(v => typeof v === 'string'));
  const vars = await templateVars({ steps }, doc ?? { title: pick.name }, {
    stage, at: pick.at, ctx: { supabase, workspaceId, entityId: pick.entity_id, dealId: pick.deal_id }, texts,
  });
  for (const s of steps) {
    if (s?.type === 'agent' && s.id && !doc) vars[`steps.${s.id}.output`] = AI_PLACEHOLDER;
  }
  return { samples, sample: pick, vars, document_id: doc?.id ?? null };
}

/**
 * What the AI step would read, for the editor's "View context" (GET-568): the material for one
 * real sample, with the step's account and parts applied. Reads only — no model call, nothing
 * written. Counts per part so the toggles can say how much each one holds.
 */
export async function automationContextPreview(supabase, workspaceId, { when, steps = [], entityId = null } = {}) {
  const samples = await previewSamples(supabase, workspaceId, when);
  const agentCfg = steps.find(st => st?.type === 'agent')?.config ?? {};
  const pick = (entityId && samples.find(x => x.entity_id === entityId)) || samples[0] || null;
  const account = agentCfg.account_id || pick?.entity_id || null;
  if (!account) return { samples, sample: null, material: null, counts: {} };
  const stage = when === 'deal_closed_lost' ? 'closed_lost' : 'closed_won';
  const full = await makeArtifact(supabase, workspaceId, { artifact: null, entityId: account, stage, prompt: null, materialOnly: true });
  const len = (v) => (Array.isArray(v) ? v.length : v ? 1 : 0);
  const m = full.material;
  const counts = {
    deal: len(m.deal) + len(m.other_deals_on_record),
    people: len(m.people),
    activity: len(m.recent_activity),
    intel: len(m.intel),
    commitments: len(m.open_commitments),
    seller: len(m.seller),
  };
  return { samples, sample: pick, account_id: account, material: withContext(m, agentCfg.context), counts };
}

/** Accounts by name, for picking the one an AI step always reads. */
export async function searchAutomationAccounts(supabase, workspaceId, q) {
  let query = supabase.from('entity_list_rows').select('entity_id, name, domain')
    .eq('workspace_id', workspaceId).eq('kind', 'account');
  const needle = String(q ?? '').trim();
  if (needle) query = query.ilike('name', `%${needle.replace(/[%_]/g, '')}%`);
  const { data } = await query.order('last_activity_at', { ascending: false, nullsFirst: false }).limit(8);
  return data ?? [];
}

/**
 * The email this flow would send, for one real recent trigger (GET-664): the simple editor's
 * preview. The AI's text is the account's latest written document when there is one, else a
 * line saying it is written when the automation runs. Reads only; nothing is sent.
 */
export async function automationEmailPreview(supabase, workspaceId, { when, steps = [], entityId = null } = {}) {
  const samples = await previewSamples(supabase, workspaceId, when);
  const pick = (entityId && samples.find(x => x.entity_id === entityId)) || samples[0] || null;
  const email = steps.find(st => st?.type === 'email');
  if (!pick || !email) return { samples, sample: pick, email: null };
  const stage = when === 'deal_closed_won' ? 'closed_won' : when === 'deal_closed_lost' ? 'closed_lost' : null;
  const { data: written } = await supabase.from('documents')
    .select('id, title, headline, sections, created_at')
    .eq('workspace_id', workspaceId).eq('subject_entity_id', pick.entity_id).is('deleted_at', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  const stageWords = stage ? stage.replace(/_/g, ' ') : 'update';
  const doc = written
    ? { ...written, title: `${pick.name} — ${stageWords}` }
    : { id: 'preview', title: `${pick.name} — ${stageWords}`, headline: null, created_at: pick.at, sections: [{ label: '', body: AI_PLACEHOLDER }] };
  const destination_target = [email.config?.to, email.config?.cc].map(x => String(x ?? '').trim()).filter(Boolean).join(', ');
  const automation = { steps, destination: 'email', destination_target };
  const mail = await composeAutomationEmail(automation, doc, {
    stage, at: pick.at, ctx: { supabase, workspaceId, entityId: pick.entity_id, dealId: pick.deal_id },
  });
  // A body that IS the AI's output shows it as the reader will read it.
  const aiText = documentText(doc);
  return { samples, sample: pick, email: { ...mail, html: undefined }, ai_text: aiText, written: !!written };
}

// ── Account signals (GET-686) ────────────────────────────────────────────────
//
// A database trigger turns each new or changed fact worth acting on into an account_signals
// row (2026_10_04_account_signals.sql). This pass sends them on: a webhook event with the record
// and the quote, and any automation that listens for that kind of signal. Every few minutes.
//
// THE TEAM'S RULES DECIDE WHAT LEAVES. A signal derived from one person's private mail is kept
// (it is theirs to see) but never sent to a webhook or used by an automation — the same message
// privacy every shared surface reads by (GET-253).
// HISTORY IS NOT NEWS. Facts filed from a backfill of old mail describe old conversations; a
// signal older than the window is recorded, not sent.

export const SIGNAL_LABEL = {
  objection_raised: 'Objection raised', objection_resolved: 'Objection resolved',
  competitor_mentioned: 'Competitor mentioned', competitor_evaluating: 'Competitor being evaluated',
  stakeholder_identified: 'Key stakeholder identified', stakeholder_joined: 'New stakeholder', stakeholder_left: 'Stakeholder left',
  budget_discussed: 'Budget discussed', buying_signal: 'Buying signal', next_step: 'Next step agreed',
  expansion_signal: 'Expansion signal', expansion_declined: 'Expansion declined', churn_risk: 'Churn risk',
};
export const SIGNAL_KINDS = Object.keys(SIGNAL_LABEL);
const SIGNAL_FRESH_HOURS = 72;
/** A routine runs for one account at most once in this window, whatever new signals arrive (GET-834). */
const SIGNAL_ACCOUNT_COOLDOWN_HOURS = 24;

// Which signal leads a conversation's one run when it raised several: the one that most needs an
// answer. Kinds not listed rank last, newest first among equals.
const SIGNAL_RANK = ['stakeholder_left', 'churn_risk', 'objection_raised', 'competitor_evaluating', 'buying_signal',
  'expansion_signal', 'competitor_mentioned', 'stakeholder_joined', 'next_step', 'budget_discussed',
  'stakeholder_identified', 'objection_resolved', 'expansion_declined'];
const rankOf = (k) => { const i = SIGNAL_RANK.indexOf(k); return i < 0 ? SIGNAL_RANK.length : i; };

/** The conversation a signal came from: where it was said, else the minute it was said. */
export function signalMoment(s) {
  const ref = typeof s?.source_ref === 'string' ? s.source_ref.trim() : '';
  if (ref) return `ref:${ref}`;
  return `at:${String(s?.occurred_at ?? '').slice(0, 16)}`;
}

/**
 * One run per account per conversation (GET-834). A call raises several signals at once (an
 * objection, a buying signal, a next step), and a routine ran once for EACH: one call, five drafted
 * emails to the same person. Grouped here by account and moment; the highest-ranked signal leads
 * the run and the rest ride along as `also`, so the one write-up answers the whole conversation.
 * Pure. Returns [{ accountId, moment, lead, signals }].
 */
export function groupSignalsForRuns(signals) {
  const groups = new Map();
  for (const s of signals ?? []) {
    if (!s?.account_id) continue;
    const moment = signalMoment(s);
    const key = `${s.account_id}|${moment}`;
    (groups.get(key) ?? groups.set(key, { accountId: s.account_id, moment, signals: [] }).get(key)).signals.push(s);
  }
  return [...groups.values()].map((g) => {
    const sorted = [...g.signals].sort((a, b) => rankOf(a.kind) - rankOf(b.kind) || String(b.occurred_at).localeCompare(String(a.occurred_at)));
    const [lead, ...rest] = sorted;
    return { ...g, lead: rest.length ? { ...lead, also: rest } : lead, signals: sorted };
  });
}

/** The run's dedupe key for one routine, account and conversation. Hashless: the moment is short text. */
export const signalRunKey = (routineId, accountId, moment) => `${routineId}:signal-moment:${accountId}:${String(moment).slice(0, 300)}`;
const SIGNAL_BATCH = 300;
const SIGNAL_RUNS_PER_PASS = 25;

export async function processAccountSignals({ onlyWorkspace = null, supabase: given = null } = {}) {
  const supabase = given ?? getSupabaseClient();
  let q = supabase.from('account_signals').select('*').is('processed_at', null)
    .order('detected_at', { ascending: true }).limit(SIGNAL_BATCH);
  if (onlyWorkspace) q = q.eq('workspace_id', onlyWorkspace);
  const { data: pending, error } = await q;
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return { processed: 0 };   // not migrated yet
    throw new Error(`account signals read failed: ${error.message}`);
  }
  if (!pending?.length) return { processed: 0 };

  const byWs = new Map();
  for (const s of pending) (byWs.get(s.workspace_id) ?? byWs.set(s.workspace_id, []).get(s.workspace_id)).push(s);
  let emitted = 0, ran = 0;
  for (const [ws, signals] of byWs) {
    try {
      const readable = await teamReadableSignals(supabase, ws, signals);
      const { data: routines } = await supabase.from('agent_routines').select('*')
        .eq('workspace_id', ws).eq('enabled', true).eq('trigger_kind', 'account_signal');
      const runnable = [];
      for (const s of signals) {
        const ok = readable.has(s.id);
        const fresh = s.occurred_at && Date.now() - new Date(s.occurred_at).getTime() <= SIGNAL_FRESH_HOURS * 3_600_000;
        if (ok && fresh) {
          emitted += await emitEvent(supabase, {
            workspaceId: ws, type: `signal.${s.kind}`, accountId: s.account_id, personId: s.entity_id !== s.account_id ? s.entity_id : null,
            occurredAt: s.occurred_at, dedupeKey: s.id, maxAgeHours: SIGNAL_FRESH_HOURS,
            data: {
              signal: s.kind, label: SIGNAL_LABEL[s.kind] ?? s.kind, title: s.title, text: s.content,
              quote: s.quote, said_by: s.speaker, source_ref: s.source_ref, detail: s.detail ?? {},
            },
          });
          runnable.push(s);
        }
        await supabase.from('account_signals').update({ processed_at: new Date().toISOString(), team_readable: ok }).eq('id', s.id);
      }
      // Each routine once per account and conversation, not once per signal (GET-834).
      for (const a of routines ?? []) {
        const wanted = Array.isArray(a.trigger_config?.signals) ? a.trigger_config.signals : [];
        const mine = runnable.filter((s) => s.account_id && (!wanted.length || wanted.includes(s.kind))
          && !(a.created_at && String(s.occurred_at) < String(a.created_at)));
        for (const g of groupSignalsForRuns(mine)) {
          if (ran >= SIGNAL_RUNS_PER_PASS) break;
          if (await runSignalAutomation(supabase, ws, a, g)) ran++;
        }
      }
    } catch (err) {
      console.error(`[signals] ${ws}:`, err?.message ?? err);
    }
  }
  if (emitted || ran) console.log(`[signals] ${pending.length} signal(s): ${emitted} webhook deliver(ies), ${ran} automation run(s)`);
  return { processed: pending.length, emitted, ran };
}

/** Which of these signals the whole team may read: their source fact passes message privacy. */
async function teamReadableSignals(supabase, workspaceId, signals) {
  const props = [...new Set(signals.map(s => s.claim_property))];
  const facts = [];
  for (let i = 0; i < props.length; i += 100) {
    const { data } = await supabase.from('claims')
      .select('entity_id, property, value, supporting_observation_ids, derived_visibility')
      .eq('workspace_id', workspaceId).in('property', props.slice(i, i + 100));
    facts.push(...(data ?? []));
  }
  const visible = await filterDerivedForViewer(supabase, workspaceId, facts, TEAM_VIEWER, { isDerived: () => true });
  const ok = new Set(visible.map(f => `${f.entity_id}|${f.property}`));
  return new Set(signals.filter(s => ok.has(`${s.entity_id}|${s.claim_property}`)).map(s => s.id));
}

/** One automation, run once for one signal: the write-up about that moment, then delivery. */
/** How much of a transcript rides into the write-up and {{call.transcript}}: about an hour's call. */
export const CALL_TRANSCRIPT_CHARS = 60_000;

/**
 * "When a call ends" (GET-706): run every enabled call_ended automation in the workspace for one
 * finished call. Called by the worker once per call, after it is read, never for a history import.
 * `call` = { meetingId, title, occurredAt, source, url, accountId, personId, attendees: [{name,
 * email}], summary, transcript, callType }. A trigger limited to some recorders (trigger_config.tools)
 * only fires for those. Each automation runs once per call.
 */
export async function runCallEndedAutomations(supabase, workspaceId, call) {
  const entityId = call?.accountId || call?.personId || null;
  if (!workspaceId || !call?.meetingId || !entityId) return { ran: 0 };
  const { data: autos, error } = await supabase.from('agent_routines').select('*')
    .eq('workspace_id', workspaceId).eq('enabled', true).eq('trigger_kind', 'call_ended');
  if (error || !autos?.length) return { ran: 0 };
  if (!call.nextSteps) call = { ...call, nextSteps: await loadCallNextSteps(supabase, workspaceId, call.sourceMeetingId ?? call.meetingId) };
  const recorder = String(call.source ?? '').toLowerCase();
  let ran = 0;
  for (const a of autos) {
    const tools = (a.trigger_config?.tools ?? a.tools ?? []).map(t => String(t).toLowerCase());
    if (tools.length && recorder && !tools.some(t => recorder.includes(t) || t.includes(recorder))) continue;
    if (await runCallAutomation(supabase, workspaceId, a, call, entityId)) ran++;
  }
  return { ran };
}

/**
 * The next steps a call produced (GET-710): the commitments filed for it, open, in the order they
 * were said. Read from the observations the call just wrote (action_item.meeting_<id>_<n>), which
 * exist before the call's automations run; their claims may not be computed yet.
 */
export async function loadCallNextSteps(supabase, workspaceId, meetingId) {
  if (!meetingId) return [];
  const { data } = await Promise.resolve(supabase.from('observations').select('property, value, observed_at')
    .eq('workspace_id', workspaceId).like('property', `action_item.meeting_${meetingId}_%`)
    .order('observed_at', { ascending: false }).limit(60)).catch(() => ({ data: [] }));
  const latest = new Map();
  for (const o of data ?? []) if (!latest.has(o.property)) latest.set(o.property, o.value ?? {});
  const n = (p) => Number(String(p).split('_').pop()) || 0;
  return [...latest.entries()]
    .filter(([, v]) => (v?.status ?? 'open') === 'open' && String(v?.title ?? '').trim())
    .sort(([a], [b]) => n(a) - n(b))
    .map(([, v]) => ({ title: String(v.title).trim(), due_at: v.due_at ?? null, theirs: !!v.awaiting_them }))
    .slice(0, 10);
}

async function runCallAutomation(supabase, workspaceId, a, call, entityId) {
  const dedupe = `${a.id}:call:${call.meetingId}`;
  const { data: seen } = await supabase.from('agent_routine_runs').select('id').eq('routine_id', a.id).eq('dedupe_key', dedupe).maybeSingle();
  if (seen) return false;
  const { data: run, error: claimError } = await supabase.from('agent_routine_runs').insert({
    workspace_id: workspaceId, routine_id: a.id, dedupe_key: dedupe, status: 'running',
  }).select('id').single();
  if (claimError) return false;   // another worker claimed this call first
  try {
    const agentCfg = (Array.isArray(a.steps) ? a.steps : []).find(st => st?.type === 'agent')?.config ?? {};
    const doc = await makeArtifact(supabase, workspaceId, {
      artifact: a.artifact, entityId: agentCfg.account_id || entityId, stage: 'call_ended', prompt: a.prompt,
      context: agentCfg.context ?? null, call, runId: run?.id ?? null, agentStep: agentStepOf(a), format: formatOf(a),
    });
    const out = await deliver(a, doc, {
      stage: 'call_ended', at: call.occurredAt,
      ctx: { supabase, workspaceId, entityId, dealId: null, call, runId: run?.id ?? null },
    });
    const { delivered } = out;
    await supabase.from('agent_routine_runs').update({ ...runOutcome(out), document_id: doc.id }).eq('id', run?.id);
    await supabase.from('agent_routines').update({ last_run_at: new Date().toISOString() }).eq('id', a.id);
    console.log(`[call-ended] ${a.name} → ${doc.title}${delivered ? ` → ${delivered}` : ''}`);
    return true;
  } catch (err) {
    await supabase.from('agent_routine_runs').update({ status: 'error', error: String(err?.message ?? err).slice(0, 500) }).eq('id', run?.id);
    console.error(`[call-ended] ${a.name} failed:`, err?.message ?? err);
    return false;
  }
}

// ── When a HubSpot field changes (GET-781) ──────────────────────────────────

/** The change as the run's signal: what the AI step and {{signal.text}} read. */
function fieldChangeSignal(cfg, ch, entityId) {
  return {
    id: `hs:${cfg.object}:${ch.objectId}:${cfg.property}:${ch.at}`, kind: 'hubspot_field_changed', label: 'HubSpot field changed',
    title: `${cfg.property_label || cfg.property} changed`, content: changeText(cfg, ch), quote: null, speaker: null,
    occurred_at: ch.at, account_id: entityId, entity_id: entityId,
    detail: { object: cfg.object, record: ch.objectId, field: cfg.property, from: ch.old, to: ch.new },
  };
}

/** One change, one run: with the account when we know it, else from the change alone. */
export async function runFieldChangeAutomation(supabase, workspaceId, a, ch, { test = false, runId: given = null, onLog = null } = {}) {
  const cfg = a.trigger_config ?? {};
  const dedupe = `${a.id}:hs:${ch.objectId}:${cfg.property}:${ch.at}`;
  let runId = given;
  if (!runId) {
    const { data: seen } = await supabase.from('agent_routine_runs').select('id').eq('routine_id', a.id).eq('dedupe_key', dedupe).maybeSingle();
    if (seen) return false;
    const { data: run, error } = await supabase.from('agent_routine_runs').insert({ workspace_id: workspaceId, routine_id: a.id, dedupe_key: dedupe, status: 'running' }).select('id').single();
    if (error) return false;
    runId = run.id;
  }
  try {
    const entityId = await entityForHubspotId(supabase, workspaceId, ch.objectId).catch(() => null);
    const signal = fieldChangeSignal(cfg, ch, entityId);
    let out, docId = null;
    if (entityId) {
      const agentCfg = (Array.isArray(a.steps) ? a.steps : []).find(st => st?.type === 'agent')?.config ?? {};
      const doc = await makeArtifact(supabase, workspaceId, {
        artifact: a.artifact, entityId: agentCfg.account_id || entityId, stage: 'hubspot_field_changed', prompt: a.prompt,
        context: agentCfg.context ?? null, signal, runId, agentStep: agentStepOf(a), format: formatOf(a),
      });
      docId = doc.id;
      out = await deliver(a, doc, { stage: 'hubspot_field_changed', at: ch.at, ctx: { supabase, workspaceId, entityId, dealId: null, signal, runId, onLog } });
    } else {
      // A record we hold no account for (a custom object, a company not synced yet): the steps
      // run from the change itself.
      out = await runSteps(a, null, { stage: 'hubspot_field_changed', at: ch.at, ctx: { supabase, workspaceId, entityId: null, dealId: null, signal, runId, onLog, writeAllInLoop: true, seedData: [{ step: 0, label: 'HubSpot', text: signal.content }] } });
    }
    await supabase.from('agent_routine_runs').update({ ...runOutcome(out), ...(docId ? { document_id: docId } : {}) }).eq('id', runId);
    if (!test) await supabase.from('agent_routines').update({ last_run_at: new Date().toISOString() }).eq('id', a.id);
    return true;
  } catch (err) {
    await supabase.from('agent_routine_runs').update({ status: 'error', error: String(err?.message ?? err).slice(0, 500) }).eq('id', runId);
    console.error(`[hubspot-field] ${a.name} failed:`, err?.message ?? err);
    return false;
  }
}

/** Every few minutes: each enabled field-change automation, the changes in the last half hour, one run each. */
export async function processHubspotFieldChanges({ onlyWorkspace = null, supabase: given = null, now = Date.now() } = {}) {
  const supabase = given ?? getSupabaseClient();
  let q = supabase.from('agent_routines').select('*').eq('enabled', true).eq('trigger_kind', 'hubspot_field_changed');
  if (onlyWorkspace) q = q.eq('workspace_id', onlyWorkspace);
  const { data: routines, error } = await q;
  if (error || !routines?.length) return { ran: 0 };
  let ran = 0;
  for (const a of routines) {
    const r = await hubspotFieldChanges(supabase, a.workspace_id, a.trigger_config ?? {}, { since: now - FIELD_CHANGE_WINDOW_MS });
    if (!r.ok) { console.warn(`[hubspot-field] ${a.name}: ${r.reason}`); continue; }
    for (const ch of r.changes.slice(0, 50)) if (await runFieldChangeAutomation(supabase, a.workspace_id, a, ch)) ran++;
  }
  return { ran };
}

async function runSignalAutomation(supabase, workspaceId, a, group) {
  const s = group.lead;
  // Signals from the same conversation that land in a later pass find this key and stop here.
  const dedupe = signalRunKey(a.id, group.accountId, group.moment);
  const { data: seen } = await supabase.from('agent_routine_runs').select('id').eq('routine_id', a.id).eq('dedupe_key', dedupe).maybeSingle();
  if (seen) return false;
  // And a routine that already ran for this account today waits: a burst of emails on one thread
  // is one conversation to answer, not one email per message.
  const since = new Date(Date.now() - SIGNAL_ACCOUNT_COOLDOWN_HOURS * 3_600_000).toISOString();
  const { data: recent } = await supabase.from('agent_routine_runs').select('id').eq('routine_id', a.id)
    .like('dedupe_key', `${a.id}:signal-moment:${group.accountId}:%`).gte('started_at', since).limit(1);
  if (recent?.length) return false;
  const { data: run, error: claimError } = await supabase.from('agent_routine_runs').insert({
    workspace_id: workspaceId, routine_id: a.id, dedupe_key: dedupe, status: 'running',
  }).select('id').single();
  if (claimError) return false;   // another worker claimed this conversation first
  try {
    const agentCfg = (Array.isArray(a.steps) ? a.steps : []).find(st => st?.type === 'agent')?.config ?? {};
    const doc = await makeArtifact(supabase, workspaceId, {
      artifact: a.artifact, entityId: agentCfg.account_id || s.account_id, stage: s.kind, prompt: a.prompt,
      context: agentCfg.context ?? null, signal: s, runId: run?.id ?? null, agentStep: agentStepOf(a), format: formatOf(a),
    });
    const out = await deliver(a, doc, {
      stage: s.kind, at: s.occurred_at,
      ctx: { supabase, workspaceId, entityId: s.account_id, dealId: null, signal: s, runId: run?.id ?? null },
    });
    const { delivered } = out;
    await supabase.from('agent_routine_runs').update({ ...runOutcome(out), document_id: doc.id }).eq('id', run?.id);
    await supabase.from('agent_routines').update({ last_run_at: new Date().toISOString() }).eq('id', a.id);
    console.log(`[signals] ${a.name} → ${doc.title}${delivered ? ` → ${delivered}` : ''}`);
    return true;
  } catch (err) {
    await supabase.from('agent_routine_runs').update({ status: 'error', error: String(err?.message ?? err).slice(0, 500) }).eq('id', run?.id);
    console.error(`[signals] ${a.name} failed:`, err?.message ?? err);
    return false;
  }
}

/**
 * What changed on an account (GET-686): its signals over the last `days`, newest first, with
 * the quote and where it was said. Team-readable only — a signal from one person's private mail
 * is not shown on a shared surface.
 */
export async function listAccountSignals(supabase, workspaceId, accountId, { days = 7, limit = 50 } = {}) {
  const since = new Date(Date.now() - Math.max(1, Math.min(days, 365)) * 86_400_000).toISOString();
  const { data, error } = await supabase.from('account_signals')
    .select('id, kind, title, content, quote, speaker, source_ref, detail, entity_id, occurred_at')
    .eq('workspace_id', workspaceId).eq('account_id', accountId).eq('team_readable', true)
    .gte('occurred_at', since).order('occurred_at', { ascending: false }).limit(Math.min(limit, 200));
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return [];
    throw new Error(`account signals read failed: ${error.message}`);
  }
  return (data ?? []).map(r => ({ ...r, label: SIGNAL_LABEL[r.kind] ?? r.kind }));
}
