// The deal overview: "How to win this deal", the top of the deal page (GET-793).
//
// The account has its AI Overview (companySummary.mjs); a deal had nothing at its top. This is
// the same kind of read, about one deal: where it stands, what is in the way, what they need to
// see from us, and the next move. Two to four short sentences (GET-797), written from the account's facts, its
// recent activity and the deal's own fields.
//
// When: on demand only. The deal page asks the first time it opens a deal with none, and the
// refresh button asks again. Nothing writes these on a timer or after every fact, so opening the
// pipeline never buys a summary per deal.
//
// Storage: state observations `deal_overview` and `deal_overview_at` on the deal entity, or on
// the company for the account's own deal (no CRM deal, id "account"), projected to claims.

import { teamReadContext, listAccountNotes, listActivities, recordObservation, activityDirection, normalizeStage, stageRank } from '@nous/core';
import { read, parseProse, acceptsProse } from '../noema/read.mjs';
import { loadOurSide, ourSideLabel } from './extractionText.mjs';

export const ACCOUNT_DEAL_ID = 'account';

const personName = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'a contact';
const plain = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

/** The deal's own fields: its name, stage, status, amount and close date, as the CRM filed them. */
async function dealFields(supabase, workspaceId, dealId) {
  const { data, error } = await supabase.from('claims').select('property, value')
    .eq('workspace_id', workspaceId).eq('entity_id', dealId).is('invalid_at', null)
    .in('property', ['name', 'stage', 'status', 'value', 'close_date']);
  if (error) throw error;
  return Object.fromEntries((data ?? []).map(r => [r.property, plain(r.value)]));
}

/**
 * Write (or rewrite) one deal's overview. Returns { overview, generated_at } when written,
 * { skipped } when there is nothing to write from.
 */
export async function refreshDealOverview(supabase, workspaceId, companyId, dealId) {
  const { data: company, error: coErr } = await supabase.from('companies')
    .select('id, name').eq('workspace_id', workspaceId).eq('id', companyId).maybeSingle();
  if (coErr) throw coErr;
  if (!company?.name) return { skipped: 'no company' };

  const { data: contactRows, error: cErr } = await supabase.from('contacts')
    .select('id, first_name, last_name, email, job_title, pipeline_stage, deal_value')
    .eq('workspace_id', workspaceId).eq('company_id', companyId);
  if (cErr) throw cErr;
  const contacts = contactRows || [];

  const implied = dealId === ACCOUNT_DEAL_ID;
  const fields = implied ? {} : await dealFields(supabase, workspaceId, dealId);
  let stage = fields.stage ? String(fields.stage) : null;
  if (implied) {
    for (const c of contacts) {
      const s = normalizeStage(c.pipeline_stage);
      if (s && stageRank(s) > stageRank(stage)) stage = s;
    }
  }
  const amount = implied
    ? contacts.reduce((best, c) => (c.deal_value != null && (best == null || c.deal_value > best) ? c.deal_value : best), null)
    : fields.value ?? null;
  const dealName = implied ? `${company.name} deal` : String(fields.name || 'this deal');

  const contactIds = contacts.map(c => c.id);
  const nameById = new Map(contacts.map(c => [c.id, personName(c)]));
  const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
  const [notes, acts, ourSide] = await Promise.all([
    listAccountNotes(supabase, workspaceId, companyId, contactIds, {}, teamReadContext(workspaceId)),
    contactIds.length ? listActivities(supabase, { contactIds, since, limit: 15 }, teamReadContext(workspaceId)) : Promise.resolve([]),
    loadOurSide(supabase, workspaceId),
  ]);
  const facts = notes.filter(n => n.source === 'signal_extraction').slice(0, 30);
  if (!facts.length && !acts.length) return { skipped: 'nothing to write from' };

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
  const dealLine = [
    `Deal: ${dealName}`,
    stage ? `stage ${stage}` : null,
    amount != null ? `amount ${amount}` : null,
    fields.close_date ? `closes ${String(fields.close_date).slice(0, 10)}` : null,
  ].filter(Boolean).join(', ');

  const prompt = `Write "How to win this deal" for a sales rep at ${ourSide?.companyName || 'our company'}: 2–4 short sentences, one paragraph of plain prose — no markdown, no bullets, no headings, no lists inside a sentence. A rep reads it in ten seconds.
Say only: the one thing most in the way, what ${company.name} needs to see from us to say yes, and the single next move. Where the deal stands is already on the page; do not restate the stage or the amount.
Name a person only when what they said or need matters. Use only what is written below; do not guess at anything not stated. If something important is unknown (who signs, the budget, the timeline), say so as part of what is in the way.

${dealLine}.${people ? `\nPeople at ${company.name}: ${people}` : ''}${factLines ? `\n\nFacts on the account:\n${factLines}` : ''}${actLines ? `\n\nRecent activity (last 45 days):\n${actLines}` : ''}

How to win this deal:`;

  const result = await read({
    supabase, workspaceId,
    feature: 'deal-overview',
    meterAs: 'signal-extraction',
    accept: acceptsProse,
    parse: parseProse,
    maxTokens: 220,
    prompt,
  });
  if (!result.ok && result.reason === 'unavailable') throw new Error(`deal overview unavailable (${dealId})`);
  if (!result.ok) return { skipped: 'empty answer' };

  const now = new Date().toISOString();
  const entityId = implied ? companyId : dealId;
  const base = { workspaceId, entityId, kind: 'state', source: 'deal_overview', method: 'inference', observedAt: now };
  await recordObservation(supabase, { ...base, property: 'deal_overview', value: result.value });
  await recordObservation(supabase, { ...base, property: 'deal_overview_at', value: now });
  console.log(`[DEAL_OVERVIEW] ${dealName} (${entityId})`);
  return { overview: result.value, generated_at: now };
}
