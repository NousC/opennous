// The account summary — the "Summary" line in the account page's AI Overview (GET-223).
//
// People had a memory summary; companies never did, so every account read "No summary yet".
// It is written from the same facts the account record shows (listAccountNotes: the
// company's own claims + its people's deal claims) and its recent activity.
//
// When it is written, and nothing else:
//   1. new facts land on the company or its people  → scheduleCompanySummary (extraction)
//   2. an account's stage changes                   → runCompanySummaryStageSweep (every 15 min,
//                                                     acts only on accounts whose stage moved)
//   3. someone presses refresh on the account page  → POST /internal/company-summary
// Nothing rewrites a summary on a timer when nothing changed.
//
// Storage: state observations on the company entity (memory_summary, summary_generated_at,
// summary_stage), projected to claims like every other company field. The companies view
// has no column for it; applyCompanyOverlay reads the claims.

import { teamReadContext } from '@nous/core';
import { listAccountNotes, listActivities, recordObservation, activityDirection,
  normalizeStage, stageRank, getSupabaseClient } from '@nous/core';
import { read, parseProse, acceptsProse } from '../noema/read.mjs';
import { loadOurSide, ourSideLabel } from './extractionText.mjs';

// Facts arriving from one conversation come in bursts (a transcript persists part by part).
// Wait this long after the first so the summary reads the whole conversation.
const COALESCE_MS = 2 * 60_000;
// Two rewrites of one account are at least this far apart unless the stage moved or a
// person asked. A later trigger inside the window is deferred to its end, never dropped.
const MIN_INTERVAL_MS = 10 * 60_000;

const pending = new Map();   // companyId → timer

/** Queue a summary refresh after new facts. Coalesces bursts; never throws. */
export function scheduleCompanySummary(workspaceId, companyId, delayMs = COALESCE_MS) {
  if (!workspaceId || !companyId || pending.has(companyId)) return;
  const timer = setTimeout(async () => {
    pending.delete(companyId);
    try {
      const r = await refreshCompanySummary(getSupabaseClient(), workspaceId, companyId, { reason: 'facts' });
      if (r?.deferMs) scheduleCompanySummary(workspaceId, companyId, r.deferMs);
    } catch (err) {
      console.warn('[COMPANY_SUMMARY_ERROR]', err.message);
    }
  }, delayMs);
  timer.unref?.();
  pending.set(companyId, timer);
}

async function currentSummaryState(supabase, companyId) {
  const { data } = await supabase.from('claims')
    .select('property, value')
    .eq('entity_id', companyId)
    .in('property', ['memory_summary', 'summary_generated_at', 'summary_stage'])
    .is('invalid_at', null);
  const by = Object.fromEntries((data || []).map(r => [r.property, r.value]));
  return { summary: by.memory_summary ?? null, generatedAt: by.summary_generated_at ?? null, stage: by.summary_stage ?? null };
}

/** The account's stage: the furthest any of its people has reached. */
function accountStage(contacts) {
  let best = null;
  for (const c of contacts) {
    const s = normalizeStage(c.pipeline_stage);
    if (s && stageRank(s) > stageRank(best)) best = s;
  }
  return best;
}

const personName = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'a contact';

/**
 * Write (or rewrite) one account's summary.
 * reason: 'facts' | 'stage' | 'manual'. 'manual' always writes.
 * Returns { summary } when written, { skipped } when not, { deferMs } when too soon.
 */
export async function refreshCompanySummary(supabase, workspaceId, companyId, { reason = 'facts' } = {}) {
  const { data: company } = await supabase.from('companies')
    .select('id, name, domain, industry').eq('workspace_id', workspaceId).eq('id', companyId).maybeSingle();
  if (!company?.name) return { skipped: 'no company' };

  const { data: contactRows } = await supabase.from('contacts')
    .select('id, first_name, last_name, email, job_title, pipeline_stage')
    .eq('workspace_id', workspaceId).eq('company_id', companyId);
  const contacts = contactRows || [];
  const stage = accountStage(contacts);

  const prev = await currentSummaryState(supabase, companyId);
  if (reason !== 'manual') {
    // A stage change REWRITES a summary; it never writes a first one. CRM syncs re-send
    // unchanged stages for every contact, and a first summary for each would be a paid
    // backfill nobody approved. First summaries come from new facts or a person asking.
    if (reason === 'stage' && !prev.summary) return { skipped: 'no summary yet' };
    if (reason === 'stage' && prev.stage === stage) return { skipped: 'stage unchanged' };
    const age = prev.generatedAt ? Date.now() - new Date(prev.generatedAt).getTime() : Infinity;
    if (reason === 'facts' && age < MIN_INTERVAL_MS) return { deferMs: MIN_INTERVAL_MS - age + 1000 };
  }

  const contactIds = contacts.map(c => c.id);
  const nameById = new Map(contacts.map(c => [c.id, personName(c)]));
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [notes, acts, ourSide] = await Promise.all([
    // Shown to the whole team → built from what the whole team may read (GET-253).
    listAccountNotes(supabase, workspaceId, companyId, contactIds, {}, teamReadContext(workspaceId)),
    contactIds.length ? listActivities(supabase, { contactIds, since, limit: 15 }, teamReadContext(workspaceId)) : Promise.resolve([]),
    loadOurSide(supabase, workspaceId),
  ]);
  const facts = notes.filter(n => n.source === 'signal_extraction').slice(0, 25);
  if (!facts.length && !acts.length) return { skipped: 'nothing to summarize' };

  const we = ourSideLabel(ourSide);
  const factLines = facts.map(f => {
    const who = f.metadata?.voiced_by_contact_id ? nameById.get(f.metadata.voiced_by_contact_id) : null;
    return `- [${f.category}] ${f.content}${who ? ` (said by ${who})` : ''}`;
  }).join('\n');
  const actLines = acts.slice(0, 10).map(a => {
    const person = nameById.get(a.contact_id) || 'someone at the company';
    const from = activityDirection(a) === 'sent' ? `${we} → ${person}` : `${person} → ${we}`;
    const when = new Date(a.occurred_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `- ${from}: ${a.activity_type}${a.description ? `: ${String(a.description).slice(0, 200)}` : ''} (${when})`;
  }).join('\n');
  const people = contacts.slice(0, 8).map(c => `${personName(c)}${c.job_title ? ` (${c.job_title})` : ''}`).join(', ');

  // ONE SUMMARY, 3–5 SENTENCES (GET-792, GET-797): the account page's AI Overview is this paragraph
  // and nothing else, so it carries what the "what we know / what they want / key concerns" lists did.
  const prompt = `Write a 3–5 sentence summary of the account ${company.name} for a sales rep at ${ourSide?.companyName || 'our company'}. One paragraph of plain prose — no markdown, no bullets, no headings.
The summary is about ${company.name}, the company. Name a person only when what they said matters to the deal.
Cover, in this order: what ${company.name} is and where the deal stands${stage ? ` (stage: ${stage})` : ''}; what they want from us; what concerns or blocks them; and the single most important thing to do next.
Use only what is written below. Do not guess at anything that is not stated.${people ? `\n\nPeople at ${company.name}: ${people}` : ''}${factLines ? `\n\nFacts on the account record:\n${factLines}` : ''}${actLines ? `\n\nRecent activity (last 30 days):\n${actLines}` : ''}\n\nSummary:`;

  // A summary has no shape to check, so the only unusable answer is no answer — and 'empty answer'
  // was a string in a return value nobody stores, gone with the next container (GET-320).
  const result = await read({
    supabase, workspaceId,
    feature: 'company-memory-summary',
    meterAs: 'signal-extraction',
    accept: acceptsProse,
    parse: parseProse,
    maxTokens: 360,
    prompt,
  });
  // An outage still throws: the refresh button on the account page answers 502 for it, and a
  // skip there would read to the rep as "there is nothing to say about this account".
  if (!result.ok && result.reason === 'unavailable') throw new Error(`company summary unavailable (${companyId})`);
  if (!result.ok) return { skipped: 'empty answer' };
  const summary = result.value;

  const now = new Date().toISOString();
  const base = { workspaceId, entityId: companyId, kind: 'state', source: 'company_summary', method: 'inference', observedAt: now };
  await recordObservation(supabase, { ...base, property: 'memory_summary', value: summary });
  await recordObservation(supabase, { ...base, property: 'summary_generated_at', value: now });
  if (stage) await recordObservation(supabase, { ...base, property: 'summary_stage', value: stage });

  console.log(`[COMPANY_SUMMARY] ${reason} — ${company.name} (${companyId})`);
  return { summary, generated_at: now };
}

/** The accounts the given people or companies belong to. */
export async function companyIdsFor(supabase, workspaceId, entityIds) {
  const ids = [...new Set(entityIds.filter(Boolean))];
  if (!ids.length) return [];
  const [{ data: cos }, { data: people }] = await Promise.all([
    supabase.from('companies').select('id').eq('workspace_id', workspaceId).in('id', ids),
    supabase.from('contacts').select('company_id').eq('workspace_id', workspaceId).in('id', ids).not('company_id', 'is', null),
  ]);
  return [...new Set([...(cos || []).map(c => c.id), ...(people || []).map(p => p.company_id)])];
}

// Reaches back a little past the cron interval so a slow tick never leaves a gap.
const STAGE_SWEEP_WINDOW_MS = 16 * 60_000;
const STAGE_SWEEP_MAX = 50;

/**
 * Stage changes come from many writers (stage derivation, CRM sync, lifecycle rules, a rep's
 * edit), so this reads the result — recent pipeline_stage observations — instead of hooking
 * each writer. Only accounts whose stage actually moved are rewritten.
 */
/**
 * Entities whose facts were retired since `since` (a supersede, a re-sort, a manual review), by
 * workspace. Their account's summary describes facts that are no longer true (2026-10-08).
 */
export async function entitiesWithRetiredFacts(supabase, since) {
  const { data, error } = await supabase.from('claims')
    .select('workspace_id, entity_id')
    .like('property', 'note.%')
    .gte('invalid_at', since)
    .limit(1000);
  if (error) { console.warn('[COMPANY_SUMMARY_SWEEP]', error.message); return new Map(); }
  const byWs = new Map();
  for (const r of data || []) {
    if (!byWs.has(r.workspace_id)) byWs.set(r.workspace_id, new Set());
    byWs.get(r.workspace_id).add(r.entity_id);
  }
  return byWs;
}

export async function runCompanySummaryStageSweep() {
  const supabase = getSupabaseClient();
  const since = new Date(Date.now() - STAGE_SWEEP_WINDOW_MS).toISOString();
  const { data, error } = await supabase.from('observations')
    .select('workspace_id, entity_id')
    .eq('property', 'pipeline_stage')
    .gte('ingested_at', since)
    .limit(1000);
  if (error) { console.warn('[COMPANY_SUMMARY_SWEEP]', error.message); return; }

  const byWs = new Map();
  for (const r of data || []) {
    if (!byWs.has(r.workspace_id)) byWs.set(r.workspace_id, new Set());
    byWs.get(r.workspace_id).add(r.entity_id);
  }
  // Accounts whose facts were retired in the window too: the summary must stop describing them.
  for (const [ws, ids] of await entitiesWithRetiredFacts(supabase, since)) {
    if (!byWs.has(ws)) byWs.set(ws, new Set());
    for (const id of ids) byWs.get(ws).add(id);
  }
  let written = 0, seen = 0;
  for (const [ws, entities] of byWs) {
    const companyIds = await companyIdsFor(supabase, ws, [...entities]);
    for (const cid of companyIds) {
      if (seen++ >= STAGE_SWEEP_MAX) break;
      try {
        const r = await refreshCompanySummary(supabase, ws, cid, { reason: 'stage' });
        if (r?.summary) written++;
      } catch (err) {
        console.warn('[COMPANY_SUMMARY_SWEEP]', cid, err.message);
      }
    }
  }
  if (written) console.log(`[COMPANY_SUMMARY_SWEEP] ${written} account(s) rewritten after a stage change or retired facts`);
}
