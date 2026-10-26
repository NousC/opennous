// What is true about an account NOW (GET-1027).
//
// A claim is written when it is said, and until now it was only ever retired at that moment: the
// extractor's "replaces" and the merge pass compare a new fact with the few look-alikes in its own
// category. Nothing ever went back over the account as a whole. So a blocker ("waiting on HubSpot
// access") stayed open after a later message said access was granted, and "the CEO (not yet
// named) drives the bot push" stayed current after the CEO became a contact on the account, and
// every agent reading the record repeated them as today's position.
//
// This pass asks one question: does anything NEW (a fact, or a person now on file) settle an older
// claim that is still open? A claim is retired (never deleted) only when something new resolves,
// answers, replaces or contradicts it, with a link to what did and why, so RECENTLY REPLACED shows
// old → new. Being old is not a reason; the freshness decay already covers that.
//
// COST. Once a night, and only for an account where something that can settle a claim changed that
// day: a new position fact or a new person. Every other account costs nothing. The prompt holds the
// new items and the older open claims, never the account's whole history; one short call each.
// A catch-up (no `since`) reads the whole record once.
import { getSupabaseClient, listAccountNotes, retireNote, teamReadContext, normalizeClaimCategory } from '@nous/core';
import { read, parseArray, acceptsArray } from '../noema/read.mjs';

// The categories that say where the account stands, and so go stale when it moves.
export const RECONCILED = new Set(['blocker', 'objection', 'authority', 'competitor', 'requirement', 'buying_signal',
  'timeline', 'budget', 'risk_signal', 'expansion_signal', 'status_quo', 'tech_stack']);

const MAX_OPEN = 40;   // older open claims offered per account
const MAX_NEW = 20;    // new facts offered per account

const day = (ts) => (ts ? String(ts).slice(0, 10) : 'undated');

/** The prompt. Claims are numbered oldest first; new ones are marked NEW. Pure. */
export function buildReconcilePrompt({ company, people, claims, today, incremental = false }) {
  const roster = people.length
    ? people.map(p => `- ${p.name}${p.title ? `, ${p.title}` : ''}${p.isNew ? ' (NEW on file)' : ''}`).join('\n')
    : '- nobody on file';
  const lines = claims.map((c, i) => `${i + 1}. ${c.isNew ? 'NEW ' : ''}[${day(c.said_at)}] [${c.category}] ${c.content}`).join('\n');
  const settles = incremental
    ? 'Only an entry marked NEW, or a person marked NEW, can settle an older entry.'
    : 'Only a LATER entry (a higher number) or the people on file can settle an entry.';
  return `You keep the record of the account ${company} current. Today is ${today}.

Older entries can stop being true: a blocker gets solved, a question gets answered, an unnamed person becomes a known contact, a plan changes, a tool gets replaced. Find the older entries that NO LONGER HOLD. ${settles}

People on file at ${company}:
${roster}

Record, oldest first:
${lines}

Retire an entry only when it is clearly resolved, done, answered, replaced or no longer accurate. Examples:
- "Needs API access before anything works" → retired by "access is working since Oct 17".
- "The CEO (not yet named) drives the decision" → retired when the CEO is on file by name; say who.
Never retire an entry because it is old, or because a newer entry only adds to it. Two different blockers both stay. When unsure, keep it.

Answer with a JSON array, [] when nothing should be retired:
[{"retire": <number>, "by": <number of the entry that settles it, or null when a person on file does>, "why": "<under 15 words: what is true now>"}]`;
}

/**
 * The model's answer, held to the rules: a real entry, settled by a later one (in incremental
 * mode, by a NEW one, and never itself NEW) or by the people on file, a reason given, each retired
 * once. Anything else is dropped, never guessed at. Pure.
 */
export function parseRetirements(value, claims, { incremental = false, newPeople = false } = {}) {
  if (!Array.isArray(value)) return [];
  const out = new Map();
  for (const r of value) {
    const i = Number(r?.retire) - 1;
    const by = r?.by == null ? null : Number(r.by) - 1;
    const why = typeof r?.why === 'string' ? r.why.trim().slice(0, 160) : '';
    if (!Number.isInteger(i) || !claims[i] || !why || out.has(i)) continue;
    if (by !== null && (!Number.isInteger(by) || !claims[by] || by === i)) continue;
    // A later entry settles an earlier one, never the reverse.
    if (by !== null && String(claims[by].said_at) < String(claims[i].said_at)) continue;
    if (incremental) {
      if (claims[i].isNew) continue;
      if (by !== null && !claims[by].isNew) continue;
      if (by === null && !newPeople) continue;
    }
    out.set(i, { id: claims[i].id, by: by === null ? null : claims[by].id, why });
  }
  return [...out.values()];
}

/**
 * Read one account and retire what no longer holds. `since`: only what was written or added after
 * it can settle anything, and nothing is asked when nothing new could (the nightly mode). Without
 * it, the whole record is read once (the catch-up). Returns { retired } or { skipped }.
 */
export async function reconcileAccount(supabase, workspaceId, companyId, { since = null, dryRun = false, log = console } = {}) {
  const { data: company } = await supabase.from('companies').select('id, name')
    .eq('workspace_id', workspaceId).eq('id', companyId).maybeSingle();
  if (!company?.name) return { skipped: 'no company' };
  const { data: contacts } = await supabase.from('contacts')
    .select('id, first_name, last_name, email, job_title, created_at')
    .eq('workspace_id', workspaceId).eq('company_id', companyId);
  const people = (contacts ?? []).map(c => ({
    name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email, title: c.job_title ?? null,
    isNew: !!since && String(c.created_at) >= since,
  })).filter(p => p.name);
  // What the whole team may read (GET-253): the record every agent and the account page see.
  const notes = await listAccountNotes(supabase, workspaceId, companyId, (contacts ?? []).map(c => c.id), {}, teamReadContext(workspaceId));
  const all = notes
    .filter(n => n.intel !== false && !n.invalid_at && RECONCILED.has(normalizeClaimCategory(n.category)))
    .map(n => ({ id: n.id, category: normalizeClaimCategory(n.category), content: n.content,
      said_at: n.said_at ?? n.created_at, isNew: !!since && String(n.created_at) >= since }));
  const newest = (list, n) => list.sort((a, b) => String(b.said_at).localeCompare(String(a.said_at))).slice(0, n);
  const fresh = newest(all.filter(c => c.isNew), MAX_NEW);
  const open = newest(all.filter(c => !c.isNew), since ? MAX_OPEN : MAX_OPEN + MAX_NEW);
  const newPeople = people.some(p => p.isNew);
  if (!open.length) return { skipped: 'nothing open' };
  if (since && !fresh.length && !newPeople) return { skipped: 'nothing new' };
  if (!since && open.length < 2 && !people.length) return { skipped: 'nothing to compare' };
  const claims = [...open, ...fresh].sort((a, b) => String(a.said_at).localeCompare(String(b.said_at)));

  const incremental = !!since;
  const result = await read({
    supabase, workspaceId, feature: 'account-reconcile', meterAs: 'signal-extraction',
    accept: acceptsArray, parse: parseArray, maxTokens: 1200,
    prompt: buildReconcilePrompt({ company: company.name, people, claims, incremental, today: new Date().toISOString().slice(0, 10) }),
  });
  if (!result.ok) return { skipped: result.reason };
  const retire = parseRetirements(result.value, claims, { incremental, newPeople });
  const byId = new Map(claims.map(c => [c.id, c]));
  for (const r of retire) {
    log.log?.(`[RECONCILE] ${company.name}: retire "${byId.get(r.id).content.slice(0, 90)}" — ${r.why}`);
    if (!dryRun) await retireNote(supabase, workspaceId, r.id, r.by, 'resolved', r.why).catch(() => {});
  }
  return { retired: retire.length, reviewed: claims.length, retirements: retire };
}

/**
 * Nightly: every account where something that can settle a claim changed in the last day, a new
 * position fact or a person added, read once. Everything else is not asked about at all.
 */
export async function runReconcileSweep({ supabase = getSupabaseClient(), sinceHours = 26, log = console } = {}) {
  const since = new Date(Date.now() - sinceHours * 3_600_000).toISOString();
  const changed = new Map();   // companyId → workspaceId
  const { data: claims } = await supabase.from('claims').select('workspace_id, entity_id')
    .like('property', 'note.%').in('value->>category', [...RECONCILED]).is('invalid_at', null)
    .gte('computed_at', since).limit(5000);
  const ids = [...new Set((claims ?? []).map(c => c.entity_id))];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const [{ data: cos }, { data: people }] = await Promise.all([
      supabase.from('companies').select('id, workspace_id').in('id', chunk),
      supabase.from('contacts').select('company_id, workspace_id').in('id', chunk).not('company_id', 'is', null),
    ]);
    for (const c of cos ?? []) changed.set(c.id, c.workspace_id);
    for (const p of people ?? []) changed.set(p.company_id, p.workspace_id);
  }
  const { data: added } = await supabase.from('contacts').select('company_id, workspace_id')
    .gte('created_at', since).not('company_id', 'is', null).limit(5000);
  for (const p of added ?? []) changed.set(p.company_id, p.workspace_id);
  let retired = 0, asked = 0;
  for (const [companyId, workspaceId] of changed) {
    const r = await reconcileAccount(supabase, workspaceId, companyId, { since, log }).catch(err => ({ skipped: err.message }));
    retired += r.retired ?? 0;
    if (!r.skipped) asked++;
  }
  log.log?.(`[RECONCILE] sweep: ${changed.size} changed account(s), ${asked} read, ${retired} claim(s) retired`);
  return { accounts: changed.size, asked, retired };
}
