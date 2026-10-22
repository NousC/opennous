// GTM insights: our interpretation of an insight (GET-1000, public since GET-1006).
//
// The customer's words say what they said. Once enough accounts say the same thing, the team wants
// to know what it means for us: which of our bets it supports or challenges, and where it points.
// That reading depends on who WE are, so it is written against our own company context (the ICP and
// the company's notes, plus whatever more the Cloud layer registers, such as the context files
// shared with the whole workspace), from the statements and quotes behind the insight, and cited by
// conversation.
//
// It is written once an insight reaches INTERPRET_MIN_ACCOUNTS accounts, and again at each further
// step of INTERPRET_STEP (10, 15, 20…), never for a pattern of a few. Here it is written for the
// insight engine's insights (insight_patterns, insightEngine.ts) and kept on the insight's own row,
// which the API returns with it (patternView).
import { listNotes, getWorkspaceEntityId } from './notes.js';
import { loadWorkspaceContext } from './insights.js';
import { getInsightPattern } from './insightEngine.js';

/** An insight gets an interpretation once this many accounts raised it, and a new one at every
 *  further step of the same size (10, 15, 20…): a sixth account rarely changes the reading, a tenth can. */
export const INTERPRET_MIN_ACCOUNTS = 5;
export const INTERPRET_STEP = 5;
/** Which step a count is on: 5–9 → 1, 10–14 → 2… Pure. */
export const interpretStep = (accounts) => Math.floor(accounts / INTERPRET_STEP);
export const INTERPRET_MAX_SOURCES = 14;
const CONTEXT_BUDGET = 6000;

// More of who we are, from outside this file: the Cloud layer registers its context library (the
// ICP file marked in Settings > Context, the files shared with the workspace). Without it the ICP
// and the company's notes are the context.
let contextSource = null;
/** `fn(sb, ws)` → { icp?: string | null, files?: { title, body }[] }. Set once by the Cloud layer. */
export function registerCompanyContextSource(fn) { contextSource = typeof fn === 'function' ? fn : null; }

/**
 * Who we are, in our own words: the ICP (the registered one, else the ICP foundation), the
 * company's notes by category, and any registered context files. Trimmed to a budget; null when
 * there is nothing, so nothing is interpreted blind.
 */
export async function ourCompanyContext(sb, ws) {
  const parts = [];
  const { data: w } = await sb.from('workspaces').select('name').eq('id', ws).maybeSingle();
  if (w?.name) parts.push(`Company: ${w.name}`);
  const extra = contextSource ? await contextSource(sb, ws).catch(() => null) : null;
  const icp = extra?.icp ?? await loadWorkspaceContext(sb, ws).catch(() => null);
  if (icp) parts.push(`## ICP\n${String(icp).slice(0, 2500)}`);
  // The company's own notes only: the ones saved on the workspace itself, never an account's.
  const self = await getWorkspaceEntityId(sb, ws).catch(() => null);
  const notes = self ? await listNotes(sb, ws, { entityId: self, limit: 80 }).catch(() => []) : [];
  const byCat = new Map();
  for (const n of notes) {
    // A label outside the claim taxonomy ('ICP', 'Product') is stored as 'general' with the label kept.
    const cat = (n.category === 'general' && typeof n.metadata?.category_raw === 'string' ? n.metadata.category_raw : n.category) || 'Notes';
    if (extra?.icp && /^icp$/i.test(cat)) continue;   // the marked file is the ICP; older ICP notes would contradict it
    const text = String(n.content ?? '').trim();
    if (!text) continue;
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(text);
  }
  for (const [cat, texts] of byCat) parts.push(`## ${cat}\n${texts.map((t) => `- ${t}`).join('\n')}`);
  for (const f of extra?.files ?? []) if (String(f.body ?? '').trim()) parts.push(`## ${f.title}\n${String(f.body).slice(0, 1500)}`);
  const text = parts.join('\n\n').trim();
  return text.length >= 80 ? text.slice(0, CONTEXT_BUDGET) : null;
}

/** The prompt. `sources`: [{ items: [{ statement, quote, account, date }] }], numbered [1]… Pure. */
export function buildInterpretationPrompt({ company, title, kind, topic, accounts, sources }) {
  const lines = sources.map((s, n) => s.items.slice(0, 3).map((it) =>
    `[${n + 1}] ${it.statement}${it.quote ? ` — "${it.quote}"` : ''} (${it.account || 'an account'}${it.date ? ', ' + it.date : ''})`).join('\n')).join('\n');
  return `WHO WE ARE (our own company, in our own words):
"""
${company}
"""

Across ${accounts} different accounts, customers and prospects keep coming back to the same thing. We filed it as: "${title}" (${kind}; topic: ${topic}).

What they said, numbered by conversation:
${lines}

Write OUR interpretation of this pattern, for our own team. Not a summary of the quotes and not a to-do list: what it tells us about our business, given who we are. Which of our bets it supports or challenges, what it says about what we build, how we position or how we sell, or about the market we are in, and the direction it points us.

Rules:
- Ground every point in the statements above and in WHO WE ARE. Cite conversations inline as [n]. Never invent numbers, customers, features or plans.
- When they describe their own business (their agents, their team, their market), say what that means for us as the company selling to them.
- Write as us ("we", "our"), plainly, the way a founder writes to a cofounder. No hype, no filler, no hedging words.
- "meaning": 2 or 3 sentences, at most 70 words.
- "direction": one sentence, at most 20 words: where this points us (e.g. "Build the data layer under agents, not another agent."). A direction, not a task list.

Output ONLY JSON: {"meaning":"... [1] ... [3]","direction":"..."}`;
}

/** The model's answer → { meaning, direction }, citations past the sources dropped; null when unusable. Pure. */
export function parseInterpretation(text, sourceCount) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let obj;
  try { obj = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  const ok = (d) => Number(d) >= 1 && Number(d) <= sourceCount;
  const cite = (t) => String(t ?? '').trim().replace(/\[(\d+)\]/g, (m, d) => (ok(d) ? m : '')).replace(/\s{2,}/g, ' ').trim();
  const meaning = cite(obj?.meaning);
  if (!meaning) return null;
  const direction = cite(obj?.direction).replace(/\[\d+\]/g, '').trim() || null;
  return { meaning: meaning.slice(0, 900), direction: direction ? direction.slice(0, 240) : null };
}

// ── The insight engine's insights ────────────────────────────────────────────

const missingColumn = (e) => ['42P01', '42703', 'PGRST204', 'PGRST205'].includes(e?.code) || /column .*interpret/.test(e?.message ?? '');
/** A read that failed (no answer, or one we could not use) is not tried again for this long, so
 *  the same insights do not cost a call every night and take the night's cap from the rest. */
export const INTERPRET_RETRY_DAYS = 7;

/** Does this insight need an interpretation now: over its bar, and never written, or written at
 *  another step (it grew to 10, or shrank back under it), and no failed read in the last week. Pure. */
export function needsInterpretation(p, now = Date.now()) {
  const accounts = p?.account_count ?? 0;
  if (!p?.at_bar || accounts < INTERPRET_MIN_ACCOUNTS) return false;
  const failed = p.interpretation_failed_at ? Date.parse(p.interpretation_failed_at) : NaN;
  if (now - failed < INTERPRET_RETRY_DAYS * 86_400_000) return false;
  if (p.interpretation_account_count == null) return true;
  return interpretStep(accounts) !== interpretStep(p.interpretation_account_count);
}

/** An insight's evidence as the prompt's sources: one per conversation, newest first. Private
 *  words are already gone (getInsightPattern): the model reads the fact, never the quote. Pure. */
export function patternSources(evidence, names = new Map()) {
  const by = new Map();
  for (const e of evidence ?? []) {
    if (!e?.content) continue;
    const ref = e.source_ref || (e.date || '').slice(0, 10) || e.id;
    if (!by.has(ref)) by.set(ref, []);
    by.get(ref).push({ statement: e.content, quote: e.quote ?? null, account: names.get(e.account_id) ?? null, date: (e.date || '').slice(0, 10) || null });
  }
  return [...by.entries()].map(([ref, items]) => ({ ref, items })).slice(0, INTERPRET_MAX_SOURCES);
}

/**
 * Write (or rewrite) one insight's interpretation. `ask(prompt)` → the model's text (the caller's
 * metered model door). Returns { status }: too_few, current, no_context, written, unusable,
 * model_unavailable, not_set_up (the columns are not there yet), or missing (no such insight).
 */
export async function interpretPattern(sb, ws, id, { ask, force = false }) {
  const { data: p, error } = await sb.from('insight_patterns')
    .select('id, type, label, title, account_count, at_bar, interpretation_account_count, interpretation_failed_at').eq('workspace_id', ws).eq('id', id).maybeSingle();
  if (error) { if (missingColumn(error)) return { status: 'not_set_up' }; throw error; }
  if (!p) return { status: 'missing' };
  if (!p.at_bar || (p.account_count ?? 0) < INTERPRET_MIN_ACCOUNTS) return { status: 'too_few', accounts: p.account_count ?? 0 };
  if (!force && !needsInterpretation(p)) return { status: 'current' };
  const company = await ourCompanyContext(sb, ws);
  if (!company) return { status: 'no_context' };
  const full = await getInsightPattern(sb, ws, id);
  const accountIds = [...new Set((full?.evidence ?? []).map((e) => e.account_id).filter(Boolean))].slice(0, 200);
  const { data: rows } = accountIds.length
    ? await sb.from('entity_list_rows').select('entity_id, name').eq('workspace_id', ws).in('entity_id', accountIds)
    : { data: [] };
  const sources = patternSources(full?.evidence, new Map((rows ?? []).map((r) => [r.entity_id, r.name])));
  if (!sources.length) return { status: 'too_few', accounts: p.account_count ?? 0 };
  const prompt = buildInterpretationPrompt({
    company, title: p.title || p.label || full?.type_label || p.type, kind: full?.type_label ?? p.type,
    topic: p.label || 'this topic', accounts: p.account_count, sources,
  });
  const failed = async (status, extra = {}) => {
    await sb.from('insight_patterns').update({ interpretation_failed_at: new Date().toISOString() }).eq('workspace_id', ws).eq('id', id);
    return { status, ...extra };
  };
  let answer;
  try { answer = await ask(prompt); } catch (e) { return failed('model_unavailable', { error: e?.message }); }
  const parsed = parseInterpretation(answer, sources.length);
  if (!parsed) return failed('unusable');
  const { error: upErr } = await sb.from('insight_patterns').update({
    interpretation_meaning: parsed.meaning, interpretation_direction: parsed.direction, interpretation_refs: sources.map((s) => s.ref),
    interpretation_account_count: p.account_count, interpreted_at: new Date().toISOString(), interpretation_failed_at: null,
  }).eq('workspace_id', ws).eq('id', id);
  if (upErr) { if (missingColumn(upErr)) return { status: 'not_set_up' }; throw upErr; }
  return { status: 'written', interpretation: { ...parsed, account_count: p.account_count } };
}

/** A workspace's insights that need an interpretation now, most accounts first. Null when the
 *  columns are not there yet. */
export async function patternsToInterpret(sb, ws) {
  const { data, error } = await sb.from('insight_patterns').select('id, account_count, at_bar, interpretation_account_count, interpretation_failed_at')
    .eq('workspace_id', ws).eq('at_bar', true).gte('account_count', INTERPRET_MIN_ACCOUNTS)
    .order('account_count', { ascending: false }).limit(500);
  if (error) { if (missingColumn(error)) return null; throw error; }
  return (data ?? []).filter(needsInterpretation);
}
