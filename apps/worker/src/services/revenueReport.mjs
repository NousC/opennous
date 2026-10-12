// Revenue Intelligence Report — the onboarding "wow", C-level edition.
//
// The moment the backfill finishes, we hold every touchpoint, meeting, extracted fact
// and fit score for the imported accounts in one graph. This turns that into a report
// a CRO would forward to the board: it does not SHOW the data, it TELLS you what's
// happening, what it's costing, what's about to happen, and what to do — with named
// accounts and the buyer's own words.
//
// Two halves:
//   1. Deterministic findings (computeFindings) — a Revenue Health score, at-risk and
//      predictive account lists, and the cross-account INTEL synthesis with verbatim
//      quotes. Real numbers and real accounts, so nothing is invented.
//   2. LLM synthesis (synthesize) — writes the diagnosis-first narrative FROM those
//      findings only.

import { getSupabaseClient, sendEmail, getProductUserEntityIds, dealStageHops } from '@nous/core';
// The per-pipeline stage medians and the collapsed-occupancy helper landed with the
// pipeline_stage_stats table (core pipelineStageStats). Read through the namespace so a
// worker running against a core built before them still sends the report on the flat
// STALL_DAYS bar, instead of failing to load at all.
import * as core from '@nous/core';
import { meterLLM } from '../utils/meterLLM.mjs';
import { createMessage, messageText } from '../lib/llm.mjs';
import { isSelfHosted } from '../lib/cloud.mjs';

const DAY = 86400000;
const QUIET_DAYS = 21;       // momentum + at-risk window: an engaged account untouched this long has lost momentum
const GOING_DARK_DAYS = 30;  // leakage scorecard's "going dark" bar — deliberately stricter than QUIET_DAYS, because "went dark" is a stronger claim than "lost momentum"
// Stalled deals. The bar is the deal's OWN pipeline's typical days in that stage (the nightly
// pipeline_stage_stats medians, see core pipelineStageStats) times STALL_MULTIPLIER. An
// Expansion deal is measured against Expansion deals; nothing is pooled across pipelines.
const STALL_DAYS = 30;          // the flat bar when the pipeline has no typical for the stage yet (no history, or under the n=8 floor)
const STALL_MULTIPLIER = 1.5;   // stalled once a deal has sat this many times its pipeline's typical days for the stage
const STALL_MIN_DAYS = 14;      // never sooner than this, however quick the typical: a week over a 5-day stage is noise, not a stall
const STALL_CEILING_DAYS = 120; // never later than this, however slow the typical: an absolute ceiling so nothing escapes forever
const SLIP_CHANGES = 3;      // close date rewritten this many times (initial + 2 moves) = a slipping deal
const PEER_MIN = 2;          // a product counts as an expansion candidate when at least this many OTHER won accounts bought it
const HIGH_FIT = 70;
// A meeting counts two ways. HELD meetings actually happened, so they are the only ones
// follow-through is measured against: a future or just-booked `meeting_scheduled` has no
// follow-up owed yet, and counting it flagged healthy, actively-booking accounts as dropped.
// SCHEDULED still counts as a real touchpoint in the activity tally and the meetings stat.
const MEETING_HELD_PROP = 'interaction.meeting_held';
const MEETING_PROPS = new Set(['interaction.meeting_held', 'interaction.meeting_scheduled']);
const REPLY_PROPS   = new Set(['interaction.email_reply', 'interaction.email_received', 'interaction.linkedin_message']);

// Human labels for the intel categories the extractor tags (see core claimCategories).
const CAT_LABEL = {
  pain: 'Pain points', objection: 'Objections', goal: 'Goals', competitor: 'Competitors',
  budget: 'Budget signals', timeline: 'Timelines', authority: 'Buying authority',
  status_quo: 'Current stack / status quo', preference: 'Preferences', relationship: 'Relationships',
};
const INTEL_ORDER = ['pain', 'objection', 'competitor', 'goal', 'budget', 'timeline', 'authority', 'status_quo'];

// ── Recipient ────────────────────────────────────────────────────────────────
async function resolveOwnerEmail(supabase, workspaceId) {
  try {
    const { data: members } = await supabase.from('workspace_members')
      .select('user_id').eq('workspace_id', workspaceId).limit(10);
    const ids = (members || []).map(m => m.user_id).filter(Boolean);
    if (!ids.length) return null;
    const { data: users } = await supabase.from('users')
      .select('email, name, created_at').in('id', ids).order('created_at', { ascending: true });
    const u = (users || []).find(x => x.email);
    return u ? { email: u.email, firstName: (u.name || '').split(/\s+/)[0] || null } : null;
  } catch { return null; }
}

// ── Gather the graph slice ───────────────────────────────────────────────────
async function gatherAccounts(supabase, workspaceId, contactIds) {
  if (!contactIds.length) return { accounts: [] };

  const byId = new Map();
  for (const id of contactIds) byId.set(id, { id, name: 'Unknown', company: null, email: null, intel: [], disposition: null });

  // Names (contacts view first, then claims for cold leads).
  const { data: cv } = await supabase.from('contacts')
    .select('id, first_name, last_name, company, company_id, email').in('id', contactIds);
  for (const c of cv || []) {
    const a = byId.get(c.id); if (!a) continue;
    a.name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Unknown';
    a.company = c.company || null; a.email = c.email || null; a.companyId = c.company_id || null;
  }
  const stillUnknown = [...byId.values()].filter(a => a.name === 'Unknown').map(a => a.id);
  if (stillUnknown.length) {
    const { data: nc } = await supabase.from('claims')
      .select('entity_id, property, value').in('entity_id', stillUnknown).in('property', ['first_name', 'last_name', 'company']);
    const nm = new Map();
    for (const c of nc || []) {
      const v = c.value; const s = typeof v === 'string' ? v : (v && typeof v === 'object' ? (v.value ?? '') : (v == null ? '' : String(v)));
      const e = nm.get(c.entity_id) || {}; e[c.property] = s; nm.set(c.entity_id, e);
    }
    for (const id of stillUnknown) { const a = byId.get(id); const e = nm.get(id); if (a && e) { a.name = [e.first_name, e.last_name].filter(Boolean).join(' ') || a.name; a.company = a.company || e.company || null; } }
  }

  // Activities.
  const { data: obs } = await supabase.from('observations')
    .select('entity_id, property, observed_at, value')
    .eq('workspace_id', workspaceId).in('entity_id', contactIds)
    .like('property', 'interaction.%').order('observed_at', { ascending: false }).limit(8000);
  const now = Date.now();
  for (const o of obs || []) {
    const a = byId.get(o.entity_id); if (!a) continue;
    a.activities = (a.activities || 0) + 1;
    const t = o.observed_at ? new Date(o.observed_at).getTime() : 0;
    if (!a.lastActivity || t > a.lastActivity) a.lastActivity = t;
    if (MEETING_PROPS.has(o.property)) { a.meetings = (a.meetings || 0) + 1; if (!a.lastMeeting || t > a.lastMeeting) a.lastMeeting = t; }
    if (o.property === MEETING_HELD_PROP) { a.heldMeetings = (a.heldMeetings || 0) + 1; if (!a.lastHeldMeeting || t > a.lastHeldMeeting) a.lastHeldMeeting = t; }
    if (REPLY_PROPS.has(o.property)) a.replies = (a.replies || 0) + 1;
  }

  // ICP fit scores.
  const { data: preds } = await supabase.from('predictions')
    .select('entity_id, predicted_value, outcome_value, resolved_at, predicted_at')
    .eq('workspace_id', workspaceId).in('entity_id', contactIds).eq('kind', 'icp_fit')
    .order('predicted_at', { ascending: false }).limit(4000);
  const scoreSeen = new Set();
  for (const p of preds || []) {
    const a = byId.get(p.entity_id); if (!a) continue;
    if (!scoreSeen.has(p.entity_id)) { const sc = Number(p.predicted_value?.score); if (Number.isFinite(sc)) a.score = sc; scoreSeen.add(p.entity_id); }
    if (p.resolved_at && p.outcome_value?.disposition && !a.disposition) a.disposition = p.outcome_value.disposition; // won | lost
  }

  // INTEL — the extracted facts (note.* claims), with verbatim content + category.
  const { data: notes } = await supabase.from('claims')
    .select('entity_id, value').in('entity_id', contactIds).like('property', 'note.%').limit(6000);
  for (const n of notes || []) {
    const a = byId.get(n.entity_id); if (!a) continue;
    // Documents (transcripts, meeting notes, recaps) live under note.* too, with a doc_type.
    // They are the SOURCE of intel, not intel: counting them here made "meeting notes" show
    // up as a category in the win/loss breakdown.
    if (n.value?.metadata?.doc_type) continue;
    const cat = (n.value?.category || 'general').toLowerCase();
    const content = String(n.value?.content || '').trim();
    if (content) a.intel.push({ category: cat, content });
  }

  // Action items (commitments made on calls) — the "unlogged commitments" gap.
  const { data: acts } = await supabase.from('observations')
    .select('entity_id, observed_at, value').eq('workspace_id', workspaceId)
    .in('entity_id', contactIds).like('property', 'action_item.%').limit(4000);
  for (const ai of acts || []) {
    const a = byId.get(ai.entity_id); if (!a) continue;
    // `title` is what the extractor and the CRM recap writer actually store; the other keys
    // are older spellings. Without `title` every real action item read as empty and was dropped.
    (a.actionItems ||= []).push({ text: String(ai.value?.title || ai.value?.description || ai.value?.summary || ai.value?.content || '').slice(0, 200), at: ai.observed_at ? new Date(ai.observed_at).getTime() : 0 });
  }

  // Questions the buyer asked on a call (HubSpot Notetaker recap → question.asked events).
  const { data: qs } = await supabase.from('observations')
    .select('entity_id, observed_at, value').eq('workspace_id', workspaceId)
    .in('entity_id', contactIds).eq('property', 'question.asked').limit(4000);
  for (const q of qs || []) {
    const a = byId.get(q.entity_id); if (!a) continue;
    (a.questions ||= []).push({ text: String(q.value?.text || '').slice(0, 200), at: q.observed_at ? new Date(q.observed_at).getTime() : 0 });
  }

  // Deals, via the account: contact → company → deal entities (belongs_to), each with the
  // dated stage history, close-date rewrites and line items the CRM sync wrote on it. This
  // is what turns "the CRM says Negotiation" into "it has said Negotiation for 94 days".
  const companyIds = [...new Set([...byId.values()].map(a => a.companyId).filter(Boolean))];
  const dealsByCompany = new Map();
  let stats = new Map();   // pipelineRef → stage label → { medianDays, sampleN }; loaded once per report, only when there are deals
  if (companyIds.length) {
    const { data: rels } = await supabase.from('relationships').select('from_entity_id, to_entity_id')
      .eq('workspace_id', workspaceId).eq('type', 'belongs_to').in('to_entity_id', companyIds).limit(5000);
    const dealCompany = new Map((rels || []).map(r => [r.from_entity_id, r.to_entity_id]));
    const dealIds = [...dealCompany.keys()];
    if (dealIds.length) {
      const [{ data: dobs }, { data: lis }, stageStats] = await Promise.all([
        supabase.from('observations').select('entity_id, property, observed_at, value, raw')
          .eq('workspace_id', workspaceId).in('entity_id', dealIds)
          .in('property', ['name', 'stage', 'close_date', 'status', 'value', 'pipeline_id'])
          .order('observed_at', { ascending: true }).limit(20000),
        supabase.from('observations').select('entity_id, value')
          .eq('workspace_id', workspaceId).in('entity_id', dealIds).like('property', 'line_item.%').limit(10000),
        loadPipelineStageStats(supabase, workspaceId),
      ]);
      stats = stageStats;
      const deals = new Map();
      for (const o of dobs || []) {
        const d = deals.get(o.entity_id) || { id: o.entity_id, companyId: dealCompany.get(o.entity_id), name: null, stageObs: [], closeDateWrites: 0, status: null, value: null, products: [], pipelineRef: null };
        if (o.property === 'name') d.name = d.name || String(o.value ?? '');
        else if (o.property === 'stage') d.stageObs.push({ value: o.value, observed_at: o.observed_at, raw: o.raw });
        else if (o.property === 'close_date') d.closeDateWrites++;
        else if (o.property === 'status') d.status = String(o.value ?? '');
        else if (o.property === 'value') { const n = Number(o.value); if (Number.isFinite(n)) d.value = n; }
        // The CRM's id of the deal's pipeline (rows are ascending, so the latest write wins).
        // This is the key the stage medians are stored under, so a deal is always measured
        // against its own pipeline's population.
        // Unwrapped the same way the other two readers of this property do (core
        // pipelineStageStats, api pipelineScope), so all three key a deal identically.
        else if (o.property === 'pipeline_id') { const raw = o.value && typeof o.value === 'object' && 'value' in o.value ? o.value.value : o.value; const ref = raw == null ? '' : String(raw).trim(); if (ref) d.pipelineRef = ref; }
        deals.set(o.entity_id, d);
      }
      // What the account bought, keyed by the provider's product id rather than the name a rep
      // typed — see core lineItemProduct. Each entry is { key, label }: group on key, print label.
      for (const li of lis || []) {
        const d = deals.get(li.entity_id);
        if (!d) continue;
        const prod = core.lineItemProduct(li.value);
        if (prod) d.products.push(prod);
      }
      for (const d of deals.values()) {
        const hops = dealStageHops(d.stageObs);
        d.occupancy = dealOccupancies(d.stageObs, hops, { now });
        d.current = d.occupancy.length ? d.occupancy[d.occupancy.length - 1] : null;
        d.outcome = hops.length ? hops[hops.length - 1].status : (d.status === 'won' || d.status === 'lost' ? d.status : 'open');
        const list = dealsByCompany.get(d.companyId) || []; list.push(d); dealsByCompany.set(d.companyId, list);
      }
    }
  }
  for (const a of byId.values()) a.deals = a.companyId ? (dealsByCompany.get(a.companyId) || []) : [];

  // Drop non-deal records — teammates (is_internal) and personal/network contacts
  // (is_personal) are not pipeline, so they never appear in the revenue report.
  const { data: relClaims } = await supabase.from('claims')
    .select('entity_id, value')
    .in('entity_id', contactIds)
    .in('property', ['is_internal', 'is_personal'])
    .is('invalid_at', null);
  const excluded = new Set((relClaims || []).filter(c => c.value === true || c.value === 'true').map(c => c.entity_id));
  // Product users (Free User signups, any non-sales stage) are not deals — drop them
  // too. A paying customer is `client` (a sales stage), so they stay in the report.
  const productUsers = await getProductUserEntityIds(supabase, workspaceId);
  for (const id of productUsers) excluded.add(id);

  const accounts = [...byId.values()].filter(a => !excluded.has(a.id));
  for (const a of accounts) {
    a.activities = a.activities || 0; a.meetings = a.meetings || 0; a.heldMeetings = a.heldMeetings || 0; a.replies = a.replies || 0;
    a.actionItems = a.actionItems || [];
    a.score = Number.isFinite(a.score) ? a.score : null;
    a.daysSinceTouch = a.lastActivity ? Math.floor((now - a.lastActivity) / DAY) : null;
    // Follow-through is only owed on meetings that actually HAPPENED — key off held
    // meetings so a future/just-booked scheduled meeting can't flag a healthy account.
    a.meetingNoFollowup = a.heldMeetings > 0 && a.lastHeldMeeting && (!a.lastActivity || a.lastActivity <= a.lastHeldMeeting);
    // A commitment with no activity logged after it (the meeting is at `at`, so if the
    // last touch is at-or-before it, nothing happened since).
    a.unloggedCommitments = a.actionItems.filter(x => x.text && (!a.lastActivity || a.lastActivity <= x.at));
    // Same rule for questions: asked on a call, and nothing from us landed after it.
    a.questions = a.questions || [];
    a.unansweredQuestions = a.questions.filter(q => q.text && (!a.lastActivity || a.lastActivity <= q.at));
    a.deals = a.deals || [];
    // Win/loss from the CRM's own decided deals when no prediction has resolved yet (a fresh
    // CRM import has outcomes long before it has a scored ICP model).
    if (!a.disposition && a.deals.length) {
      if (a.deals.some(d => d.outcome === 'won')) a.disposition = 'won';
      else if (a.deals.every(d => d.outcome === 'lost')) a.disposition = 'lost';
    }
  }
  return { accounts, stats };
}

// The stored per-pipeline stage medians for the workspace. An empty map is a complete answer:
// every deal then falls back to the flat STALL_DAYS bar. A missing table (migration not yet
// applied), a missing export (older core) and a read error all land there on purpose, because
// a report on the default bar beats no report.
async function loadPipelineStageStats(supabase, workspaceId) {
  try {
    if (typeof core.getPipelineStageStats !== 'function') return new Map();
    const stats = await core.getPipelineStageStats(supabase, workspaceId);
    return stats instanceof Map ? stats : new Map();
  } catch (e) {
    console.warn('[REVENUE_REPORT] pipeline stage stats unavailable, using the default stall bar:', e?.message || e);
    return new Map();
  }
}

// A deal's time in each stage, measured the same way the medians are. The CRM sync re-writes
// the current stage on every edit to the deal, so the raw hops split one 30-day stay into a
// "completed" 19 and a censored 11; the medians are computed on the collapsed stay (core
// dealStageOccupanciesForStats), so the numerator here must be too, or a 40-day stall reads as
// 11 days against a typical of 20. Falls back to the raw hops on an older core.
function dealOccupancies(stageObs, hops, opts) {
  if (typeof core.dealStageOccupanciesForStats === 'function') return core.dealStageOccupanciesForStats(stageObs, opts);
  return core.dealStageOccupancies(hops, opts);
}

/**
 * The stall bar for one deal's (pipeline, stage), from the typical days there or from nothing.
 * `typical` is what core typicalDaysFor answers: `{ medianDays, sampleN }` when the deal's own
 * pipeline has an honest median for the stage (n >= 8), null otherwise. Pure.
 *
 *   null     → { days: STALL_DAYS, basis: 'default' }
 *   typical  → { days: clamp(round(median * STALL_MULTIPLIER), STALL_MIN_DAYS, STALL_CEILING_DAYS),
 *                basis: 'pipeline_median', typicalDays, sampleN }
 */
export function stallThreshold(typical) {
  if (!typical || !Number.isFinite(typical.medianDays)) return { days: STALL_DAYS, basis: 'default' };
  const days = Math.min(Math.max(Math.round(typical.medianDays * STALL_MULTIPLIER), STALL_MIN_DAYS), STALL_CEILING_DAYS);
  return { days, basis: 'pipeline_median', typicalDays: typical.medianDays, sampleN: typical.sampleN };
}

/**
 * The stall rule for one deal: `{ stalled, threshold }`. A deal is stalled when it is still
 * sitting in its current stage (censored occupancy) at or past the bar for its OWN pipeline
 * and that stage. `stats` is the map core getPipelineStageStats returns (pipelineRef → stage
 * label → stat); a missing lookup means the flat bar. Pure, so the rule can be tested on its own.
 */
export function stallCheck(deal, stats) {
  const cur = deal?.current;
  const typical = cur && typeof core.typicalDaysFor === 'function' ? core.typicalDaysFor(stats, deal.pipelineRef, cur.label) : null;
  const threshold = stallThreshold(typical);
  const stalled = !!(cur && cur.censored && Number.isFinite(cur.days) && cur.days >= threshold.days);
  return { stalled, threshold };
}

// ── Deterministic findings ───────────────────────────────────────────────────
function computeFindings({ accounts, stats = new Map() }) {
  const nm = (a) => a.name + (a.company ? ` (${a.company})` : '');
  const withScore = accounts.filter(a => a.score != null);
  const engaged = accounts.filter(a => a.activities > 0);
  const highFit = withScore.filter(a => a.score >= HIGH_FIT);
  const now = Date.now();

  const totals = {
    accounts: accounts.length,
    activities: accounts.reduce((s, a) => s + a.activities, 0),
    meetings: accounts.reduce((s, a) => s + a.meetings, 0),
    replies: accounts.reduce((s, a) => s + a.replies, 0),
    engaged: engaged.length,
    highFit: highFit.length,
  };

  // Revenue Health score — follow-through, high-fit coverage, momentum.
  const withMeetings = accounts.filter(a => a.heldMeetings > 0);
  const followThrough = withMeetings.length ? 1 - withMeetings.filter(a => a.meetingNoFollowup).length / withMeetings.length : null;
  const highFitCoverage = highFit.length ? highFit.filter(a => a.activities > 0).length / highFit.length : null;
  const momentum = engaged.length ? engaged.filter(a => a.daysSinceTouch != null && a.daysSinceTouch <= QUIET_DAYS).length / engaged.length : null;
  const parts = [[followThrough, 0.4], [highFitCoverage, 0.35], [momentum, 0.25]].filter(([v]) => v != null);
  const wsum = parts.reduce((s, [, w]) => s + w, 0);
  const health = {
    score: wsum ? Math.round(100 * parts.reduce((s, [v, w]) => s + v * w, 0) / wsum) : null,
    followThroughPct: followThrough == null ? null : Math.round(followThrough * 100),
    highFitCoveragePct: highFitCoverage == null ? null : Math.round(highFitCoverage * 100),
    momentumPct: momentum == null ? null : Math.round(momentum * 100),
  };

  // At risk.
  const quietHighFit = highFit.filter(a => a.daysSinceTouch != null && a.daysSinceTouch >= QUIET_DAYS)
    .sort((a, b) => b.score - a.score).slice(0, 8).map(a => ({ name: nm(a), score: a.score, days: a.daysSinceTouch }));
  const meetingsNoFollowup = accounts.filter(a => a.meetingNoFollowup).sort((a, b) => b.heldMeetings - a.heldMeetings)
    .slice(0, 8).map(a => ({ name: nm(a), meetings: a.heldMeetings, score: a.score }));
  const neverEngaged = accounts.filter(a => a.activities === 0).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 6).map(a => ({ name: nm(a), score: a.score }));

  // Predictions.
  const aboutToSlip = highFit.filter(a => a.daysSinceTouch != null && a.daysSinceTouch >= QUIET_DAYS && a.activities > 0)
    .sort((a, b) => b.score - a.score).slice(0, 6).map(a => ({ name: nm(a), score: a.score, days: a.daysSinceTouch }));
  const nextBest = highFit.filter(a => a.meetings === 0 && a.activities <= 3)
    .sort((a, b) => b.score - a.score).slice(0, 6).map(a => ({ name: nm(a), score: a.score, activities: a.activities }));

  // Effort vs fit.
  const mostActive = [...engaged].sort((a, b) => b.activities - a.activities).slice(0, 6)
    .map(a => ({ name: nm(a), activities: a.activities, meetings: a.meetings, score: a.score }));
  const overWorkedLowFit = engaged.filter(a => a.score != null && a.score < 40 && a.activities >= 3)
    .sort((a, b) => b.activities - a.activities).slice(0, 5).map(a => ({ name: nm(a), activities: a.activities, score: a.score }));

  // INTEL synthesis — cross-account, with verbatim quotes.
  const catMap = new Map();
  for (const a of accounts) {
    const seenCat = new Set();
    for (const it of a.intel) {
      const c = it.category;
      const e = catMap.get(c) || { category: c, label: CAT_LABEL[c] || c, count: 0, accounts: new Set(), quotes: [] };
      e.count += 1; e.accounts.add(a.id);
      if (e.quotes.length < 4 && !seenCat.has(c)) { e.quotes.push({ who: a.name, text: it.content.slice(0, 220) }); seenCat.add(c); }
      catMap.set(c, e);
    }
  }
  const intel = [...catMap.values()].map(e => ({ category: e.category, label: e.label, count: e.count, accounts: e.accounts.size, quotes: e.quotes }))
    .sort((a, b) => (INTEL_ORDER.indexOf(a.category) + 100 * (INTEL_ORDER.indexOf(a.category) < 0)) - (INTEL_ORDER.indexOf(b.category) + 100 * (INTEL_ORDER.indexOf(b.category) < 0)) || b.count - a.count);

  // Win / loss.
  const won = accounts.filter(a => a.disposition === 'won');
  const lost = accounts.filter(a => a.disposition === 'lost');
  const catShare = (list) => {
    const m = new Map();
    for (const a of list) for (const it of new Set(a.intel.map(x => x.category))) m.set(it, (m.get(it) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, n]) => ({ label: CAT_LABEL[c] || c, count: n }));
  };
  const winLoss = { won: won.length, lost: lost.length, enough: won.length + lost.length >= 3,
    wonShare: catShare(won), lostShare: catShare(lost) };

  // ── Leakage scorecard: gaps between what the CRM says and what the calls/emails
  //    say. Same shape every time (record vs. reality). Three are computable from the
  //    graph today; missing-stakeholders, missed-expansion and contradictions come as
  //    the identity + extraction layers catch up.
  const RISK_CATS = new Set(['competitor', 'objection', 'budget']);
  const riskAccounts = accounts.filter(a => a.intel.some(it => RISK_CATS.has(it.category)));
  const staleAll = accounts.filter(a => a.activities > 0 && a.daysSinceTouch != null && a.daysSinceTouch >= GOING_DARK_DAYS);
  const unloggedAll = accounts.filter(a => a.unloggedCommitments.length);

  // ── From the CRM's own history (deal stage timeline, close-date rewrites, line items) and
  //    the notetaker's recaps. Deals belong to accounts, and several contacts share an
  //    account, so these are keyed by company to name each deal once.
  const seenDeal = new Set();
  const stalled = [], slipped = [];
  for (const a of accounts) {
    for (const d of a.deals) {
      if (seenDeal.has(d.id)) continue;
      if (d.outcome !== 'open') continue;
      const stall = stallCheck(d, stats);
      if (stall.stalled) {
        seenDeal.add(d.id);
        // threshold_days / basis / typical_days / pipeline are additive: `basis` says whether the
        // bar was the pipeline's own median or the flat default, so the narrative can cite
        // "94 days, typical 21 for this pipeline" or admit there is no history yet.
        stalled.push({
          account: a.company || nm(a), deal: d.name || 'Untitled deal', stage: d.current.label, days: Math.round(d.current.days), value: d.value,
          threshold_days: stall.threshold.days, basis: stall.threshold.basis,
          typical_days: stall.threshold.basis === 'pipeline_median' ? stall.threshold.typicalDays : null,
          pipeline: d.pipelineRef ?? null,
        });
      } else if (d.closeDateWrites >= SLIP_CHANGES) {
        seenDeal.add(d.id);
        slipped.push({ account: a.company || nm(a), deal: d.name || 'Untitled deal', moves: d.closeDateWrites - 1, stage: d.current?.label ?? null, value: d.value });
      }
    }
  }
  stalled.sort((x, y) => y.days - x.days);
  slipped.sort((x, y) => y.moves - x.moves);

  const unansweredAll = accounts.filter(a => a.unansweredQuestions?.length);

  // Missed expansion: what won accounts bought, versus what their peers bought. An account
  // whose peers (PEER_MIN or more other won accounts) bought a product it never did, is a
  // pitch that never happened. Needs line items on deals (CRM sync, commerce pass).
  const productAccounts = new Map();   // product key → Set(companyId)
  const productNames = new Map();      // product key → Map(label → times seen)
  const productCanonical = new Map();  // product key → the catalog's own name for it
  const boughtBy = new Map();          // companyId → { name, products:Set(product key) }
  for (const a of accounts) {
    if (!a.companyId) continue;
    for (const d of a.deals) {
      if (d.outcome !== 'won') continue;
      const rec = boughtBy.get(a.companyId) || { name: a.company || nm(a), products: new Set() };
      for (const p of d.products) {
        rec.products.add(p.key);
        (productAccounts.get(p.key) || productAccounts.set(p.key, new Set()).get(p.key)).add(a.companyId);
        if (p.canonical) productCanonical.set(p.key, p.label);
        const names = productNames.get(p.key) || productNames.set(p.key, new Map()).get(p.key);
        names.set(p.label, (names.get(p.label) ?? 0) + 1);
      }
      boughtBy.set(a.companyId, rec);
    }
  }
  // One product id carries several typed names ("Shelfwise", "Shelfwise Pro 2.0 Annual", "Shelf
  // Wise (EU)"). Print the catalog's own name for it. Only when the catalog has none
  // — a deleted product, an ad-hoc line, or a row synced before the catalog was read — fall
  // back to the name that team typed most, which is a guess and is treated as one.
  const labelFor = (key) => {
    const canonical = productCanonical.get(key);
    if (canonical) return canonical;
    const names = productNames.get(key);
    if (!names) return key;
    let best = key, seen = -1;
    for (const [label, n] of names) if (n > seen) { best = label; seen = n; }
    return best;
  };
  const missedExpansion = [];
  for (const [companyId, rec] of boughtBy) {
    const candidates = [...productAccounts.entries()]
      .filter(([p, owners]) => !rec.products.has(p) && [...owners].filter(o => o !== companyId).length >= PEER_MIN)
      .map(([p, owners]) => ({ product: labelFor(p), peers: [...owners].filter(o => o !== companyId).length }))
      .sort((x, y) => y.peers - x.peers).slice(0, 3);
    if (candidates.length) missedExpansion.push({ account: rec.name, bought: [...rec.products].slice(0, 4).map(labelFor), never_pitched: candidates });
  }

  const leakage = {
    total: riskAccounts.length + staleAll.length + unloggedAll.length
      + stalled.length + slipped.length + unansweredAll.length + missedExpansion.length,
    stalledDeals: { count: stalled.length, items: stalled.slice(0, 8) },
    slippedDeals: { count: slipped.length, items: slipped.slice(0, 6) },
    unansweredQuestions: {
      count: unansweredAll.length,
      items: unansweredAll.slice(0, 8).map(a => ({ name: nm(a), question: a.unansweredQuestions[0].text })),
    },
    missedExpansion: { count: missedExpansion.length, items: missedExpansion.slice(0, 6) },
    hiddenRisks: {
      count: riskAccounts.length,
      items: riskAccounts.slice(0, 8).map(a => { const r = a.intel.find(it => RISK_CATS.has(it.category)); return { name: nm(a), category: CAT_LABEL[r.category] || r.category, quote: r.content.slice(0, 200) }; }),
    },
    staleAccounts: {
      count: staleAll.length,
      items: [...staleAll].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 8).map(a => ({ name: nm(a), days: a.daysSinceTouch, score: a.score })),
    },
    unloggedCommitments: {
      count: unloggedAll.length,
      items: unloggedAll.slice(0, 8).map(a => ({ name: nm(a), commitment: a.unloggedCommitments[0].text })),
    },
  };

  return { totals, health, leakage, quietHighFit, meetingsNoFollowup, neverEngaged, aboutToSlip, nextBest, mostActive, overWorkedLowFit, intel, winLoss };
}

// ── LLM synthesis (diagnosis-first) ──────────────────────────────────────────
async function synthesize(supabase, workspaceId, findings, firstName) {
  const prompt = `You are a revenue-intelligence analyst writing a report for a GTM leader. Nous resolved every email, meeting and call for their accounts into one graph, extracted the buyer's own words, and scored each account for fit. Write like a sharp CRO advisor: a point of view, not a data dump.

Write FROM THE FINDINGS BELOW ONLY. Never invent an account, number, quote, or pattern that isn't here. Name accounts. Quote buyers verbatim from the intel quotes. Warm, direct, no fluff, no marketing, no em dashes.

The core idea: you found GAPS between what their CRM says and what their conversations actually say. Report those gaps.

Format EXACTLY as markdown:
Subject: <one-line subject stating the single biggest gap you found, with the number>

## The diagnosis
<2 to 4 sentences. Name the ONE constraint and cite leakage.total as "N gaps between your CRM and your conversations." A verdict, not a summary.>

## Hidden risks in your conversations
<From leakage.hiddenRisks. For each, name the account, the risk type, and the buyer's VERBATIM quote. This is a competitor/objection/budget signal sitting in a call that the CRM doesn't reflect.>

## Accounts going dark
<From leakage.staleAccounts. Named accounts that had real activity and then went quiet 30+ days. One line each.>

## Commitments made and never logged
<From leakage.unloggedCommitments. Named accounts where a next step was promised on a call with no follow-up after. Quote the commitment.>

## Deals stuck in a stage
<From leakage.stalledDeals and leakage.slippedDeals. Name the deal and the account, the stage it has sat in and for how many days, or how many times its close date has moved. For a stalled deal, when typical_days is present cite it as "N days, typical M for this pipeline"; when typical_days is null say "no pipeline history yet". These come from the CRM's own stage history, so they are facts, not estimates.>

## Questions your buyers asked that nobody answered
<From leakage.unansweredQuestions. Name the account and quote the question verbatim. A buyer asked this on a call and no one from your side followed up.>

## Expansion you never pitched
<From leakage.missedExpansion. Name the account, what it bought, and which products its peer accounts bought that it was never offered. This is revenue sitting in accounts you already won.>

## Your next best deals
<From nextBest: high-fit accounts barely touched. Name them, this is found pipeline.>

## Do this now
<3 to 5 ranked, specific actions, each tied to a named account or a process fix.>

Skip any section whose findings are empty. Recipient first name: ${firstName || 'there'}

FINDINGS:
${JSON.stringify(findings, null, 1).slice(0, 16000)}`;

  let raw = '';
  try {
    // Prose a person reads: the writing tier (WRITING_MODEL).
    const msg = await createMessage({ feature: 'revenue-report', tier: 'writing', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] });
    await meterLLM(supabase, workspaceId, 'revenue-report', msg);
    raw = messageText(msg).trim();
  } catch (e) { console.error('[REVENUE_REPORT] llm error:', e?.message || e); }
  return parseMarkdownReport(raw, findings);
}

function parseMarkdownReport(raw, f) {
  const fallbackSummary = `We resolved ${f.totals.activities} touchpoints and ${f.totals.meetings} meetings across ${f.totals.accounts} accounts. Here's what stands out.`;
  if (!raw) return { subject: 'Your revenue intelligence report', summary: fallbackSummary, sections: [] };
  let body = raw.replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let subject = 'Your revenue intelligence report';
  const sm = body.match(/^\s*subject:\s*(.+)$/im);
  if (sm) { subject = sm[1].trim(); body = body.replace(/^\s*subject:\s*.+$/im, '').trim(); }
  const parts = body.split(/\n(?=##\s)/);
  let summary = '';
  let blocks = parts;
  if (parts[0] && !/^##\s/.test(parts[0])) { summary = parts[0].trim(); blocks = parts.slice(1); }
  const sections = [];
  for (const blk of blocks) { const m = blk.match(/^##\s*(.+?)\n([\s\S]*)$/); if (m && m[2].trim()) sections.push({ title: m[1].trim(), body: m[2].trim() }); }
  return { subject, summary: summary || fallbackSummary, sections };
}

// ── Render ───────────────────────────────────────────────────────────────────
function mdInline(s) {
  return String(s ?? '')
    .replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
function mdBlock(body) {
  const lines = String(body || '').split('\n');
  let html = '', inList = false;
  for (const ln of lines) {
    const t = ln.trim();
    if (/^[-*]\s+/.test(t)) { if (!inList) { html += '<ul style="margin:6px 0 6px 18px;padding:0">'; inList = true; } html += `<li style="margin:3px 0">${mdInline(t.replace(/^[-*]\s+/, ''))}</li>`; }
    else { if (inList) { html += '</ul>'; inList = false; } if (t) html += `<p style="margin:8px 0">${mdInline(t)}</p>`; }
  }
  if (inList) html += '</ul>';
  return html;
}
function healthColor(s) { return s == null ? '#6B655B' : s >= 70 ? '#15803d' : s >= 45 ? '#E0912B' : '#b45309'; }

function renderHtml(report, f) {
  const h = f.health;
  const stat = (n, l) => `<td style="padding:8px 12px;text-align:center"><div style="font-size:20px;font-weight:700;color:#1A1712">${n}</div><div style="font-size:10px;color:#6B655B;text-transform:uppercase;letter-spacing:.04em">${l}</div></td>`;
  const scoreBlock = h.score == null ? '' : `<div style="text-align:center;margin:0 0 18px">
    <div style="font-size:11px;color:#6B655B;text-transform:uppercase;letter-spacing:.05em">Revenue Health</div>
    <div style="font-size:40px;font-weight:800;color:${healthColor(h.score)};line-height:1.1">${h.score}<span style="font-size:18px;color:#6B655B">/100</span></div>
    <div style="font-size:11px;color:#6B655B">Follow-through ${h.followThroughPct ?? '—'}% · High-fit coverage ${h.highFitCoveragePct ?? '—'}% · Momentum ${h.momentumPct ?? '—'}%</div>
  </div>`;
  const lk = f.leakage || { total: 0 };
  const gapCell = (n, l) => `<td style="padding:12px 8px;text-align:center;border:1px solid #E4DED1;background:#fff;width:25%"><div style="font-size:24px;font-weight:800;color:${n > 0 ? '#b45309' : '#6B655B'}">${n}</div><div style="font-size:10.5px;color:#6B655B;line-height:1.25">${l}</div></td>`;
  const c = (k) => lk[k]?.count ?? 0;
  // Two rows: what the conversations say the CRM doesn't, then what the CRM's own history says.
  const scorecard = lk.total ? `<div style="margin:0 0 18px">
    <div style="font-size:15.5px;font-weight:700;color:#1A1712;text-align:center;margin-bottom:8px">Nous found ${lk.total} gap${lk.total === 1 ? '' : 's'} between your CRM and your conversations</div>
    <table style="width:100%;border-collapse:collapse;border-radius:12px;overflow:hidden">
      <tr>${gapCell(c('hiddenRisks'), 'Hidden risks')}${gapCell(c('staleAccounts'), 'Accounts going dark')}${gapCell(c('unloggedCommitments'), 'Unlogged commitments')}${gapCell(c('unansweredQuestions'), 'Unanswered buyer questions')}</tr>
      <tr>${gapCell(c('stalledDeals'), 'Deals stuck in a stage')}${gapCell(c('slippedDeals'), 'Close dates that keep moving')}${gapCell(c('missedExpansion'), 'Expansion never pitched')}<td style="border:1px solid #E4DED1;background:#FBFAF5"></td></tr>
    </table>
  </div>` : '';
  const sections = (report.sections || []).map(s =>
    `<div style="margin:22px 0"><div style="font-size:15px;font-weight:700;color:#1A1712;margin-bottom:4px">${mdInline(s.title)}</div><div style="font-size:14px;line-height:1.6;color:#3a352d">${mdBlock(s.body)}</div></div>`
  ).join('');
  return `<div style="max-width:640px;margin:0 auto;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1A1712;padding:8px 4px">
  <div style="font-size:13px;color:#6B655B;margin-bottom:12px">Nous · Revenue Intelligence Report</div>
  ${scoreBlock}
  ${scorecard}
  <table style="width:100%;border-collapse:collapse;background:#FBFAF5;border:1px solid #E4DED1;border-radius:12px;margin-bottom:6px"><tr>
    ${stat(f.totals.accounts, 'Accounts')}${stat(f.totals.activities, 'Touchpoints')}${stat(f.totals.meetings, 'Meetings')}${stat(f.totals.highFit, 'High fit')}
  </tr></table>
  <div style="font-size:14px;line-height:1.6;color:#3a352d;margin:14px 0">${mdInline(report.summary)}</div>
  ${sections}
  <div style="margin-top:26px;font-size:12px;color:#6B655B;border-top:1px solid #E4DED1;padding-top:12px">Generated from your account graph in Nous. It sharpens every time your team talks to an account.</div>
</div>`;
}
function renderText(report, f) {
  const secs = (report.sections || []).map(s => `${s.title}\n${s.body}`).join('\n\n');
  const hs = f.health.score == null ? '' : `Revenue Health: ${f.health.score}/100\n`;
  return `Nous Revenue Intelligence Report\n${hs}\n${report.summary}\n\n${f.totals.accounts} accounts · ${f.totals.activities} touchpoints · ${f.totals.meetings} meetings · ${f.totals.highFit} high-fit\n\n${secs}\n\nGenerated from your account graph in Nous.`;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────
/**
 * The deterministic half on its own: gather + compute, no LLM, no email. For the audit UI,
 * dry runs, and tests — the same findings the emailed report is written from.
 */
export async function computeRevenueFindings(supabase, workspaceId, contactIds) {
  const { accounts, stats } = await gatherAccounts(supabase, workspaceId, contactIds);
  if (!accounts?.length) return { accounts: 0, findings: null };
  return { accounts: accounts.length, findings: computeFindings({ accounts, stats }) };
}

export async function generateAndEmailRevenueReport(supabase, workspaceId, contactIds, _payload, opts = {}) {
  if (isSelfHosted() && !opts.recipient) return { sent: false, reason: 'self_hosted' };
  if (!process.env.ANTHROPIC_API_KEY) return { sent: false, reason: 'no_llm' };

  const recipient = opts.recipient ? { email: opts.recipient, firstName: opts.firstName || null } : await resolveOwnerEmail(supabase, workspaceId);
  if (!recipient?.email) return { sent: false, reason: 'no_recipient' };

  const { accounts, stats } = await gatherAccounts(supabase, workspaceId, contactIds);
  if (!accounts?.length) return { sent: false, reason: 'no_accounts' };

  const findings = computeFindings({ accounts, stats });
  if (findings.totals.activities === 0) return { sent: false, reason: 'no_activity' };

  const report = await synthesize(supabase, workspaceId, findings, recipient.firstName);
  const html = renderHtml(report, findings);
  const text = renderText(report, findings);

  await sendEmail({ to: recipient.email, subject: report.subject || 'Your revenue intelligence report', text, html, tag: 'REVENUE_REPORT' });
  console.log(`[REVENUE_REPORT] sent to ${recipient.email} — ${findings.totals.accounts} accounts, health ${findings.health.score}`);
  return { sent: true, report, findings };
}
