// A record's intel, grouped into topics — the Intel tab on accounts, deals and people.
//
// Extraction writes one claim per thing heard, and the same thing is heard on every call: on
// one busy account (about a hundred facts) lead routing was six chips, "staff don't log in" about
// six, and the showroom tablets eight chips across three categories. The page grouped by
// category, so one topic was scattered and every restatement was another chip. On that account
// roughly half of the facts restated another.
//
// A topic is the projection: which facts are about the same thing, which of those restate each
// other, and one sentence on where it stands now. The facts are untouched — this is a view over
// them, stored in intel_topics, rebuilt only when the record's fact set changes (fact_hash).
// One model read per rebuild, on the extraction tier.

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Note } from './notes.js';
import { CLAIM_CATEGORY_KEYS } from './claimCategories.js';

export interface IntelTopic {
  label: string;
  kind: string;
  summary: string;
  /** Groups of claim ids; each inner list is one fact and its restatements, newest first. */
  facts: string[][];
}

export interface IntelTopicsRow {
  topics: IntelTopic[];
  fact_hash: string;
  fact_count: number;
  computed_at: string;
}

/** Below this many facts the chips already read fine; no topics are built. */
export const INTEL_TOPICS_MIN_FACTS = 6;
/** The newest facts a rebuild reads. An account past this is summarised from its recent history. */
export const INTEL_TOPICS_MAX_FACTS = 250;

/** The facts a topic pass reads: intel only (no documents, health reads, speaker links). */
export function topicFacts(notes: Note[]): Note[] {
  return notes
    .filter(n => n.intel && n.is_active !== false && (n.content ?? '').trim())
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
    .slice(0, INTEL_TOPICS_MAX_FACTS);
}

export function intelFactHash(notes: Note[]): string {
  return createHash('sha1').update(notes.map(n => n.id).sort().join(',')).digest('hex');
}

function day(iso?: string | null): string {
  return (iso ?? '').slice(0, 10);
}

/** How many topics a record of n facts may have: about one per seven facts, between 3 and 12. */
export function maxTopics(n: number): number {
  return Math.min(12, Math.max(3, Math.round(n / 7)));
}

export function buildIntelTopicsPrompt(facts: Note[], previous: IntelTopic[] = []): string {
  const list = facts.map((f, i) =>
    `${i}. [${f.category}] ${day(f.created_at)} — ${(f.content ?? '').replace(/\s+/g, ' ').slice(0, 320)}`).join('\n');
  const cap = maxTopics(facts.length);
  const keep = previous.length
    ? `\nTopic labels already in use on this record — reuse a label when its topic still fits, so the page does not reshuffle:\n${previous.map(t => `- ${t.label}`).join('\n')}\n`
    : '';
  return `Below are ${facts.length} facts a sales team has gathered about ONE customer record, newest first. Each is [category] date — fact.

Group them into TOPICS, the way a rep would name what the account is about: "Field Scanners", "Lead Router Setup", "Reporting Adoption", "Invoice Disputes", "Weekend Support", "Churn Risk".

Rules for topics:
- A topic is a concrete subject — a product, a tool, a process, a person change, a risk. Never a category name ("Pain", "Status Quo", "General").
- A topic never mixes groups. The groups a rep reads by: buying signals (buying_signal, expansion_signal); blockers (blocker); risks (risk_signal, staff_change); objections (objection); decision & budget (authority, budget, timeline, requirement); tech stack (tech_stack); competitors (competitor); everything else. Within one group, facts about the same subject belong together (a field scanner's usage and the ask for more scanners are one topic); a timeline and a blocker about the same plan are two topics. (GET-776: one account read "Nous Integration Strategy" over a timeline, a buying signal, a blocker, two tool facts and an objection — a theme nobody can act on.)
- The tech stack is one topic per tool, labelled with the tool's name ("GrokBot", "HubSpot", "Slack").
- At most ${cap} topics. Less is more: fold a thin topic into its nearest neighbour rather than keep it alone.
- "Background" is the one topic for stray details that fit no subject (opening hours, website traffic, customer base). Keep it small — at most 6 facts. Anything that touches a subject goes in that subject's topic.
- label: 2 to 4 words, Title Case, names the subject. No trailing period.
- kind: the one category, from this list, that says most about what the topic means for the deal: ${CLAIM_CATEGORY_KEYS.join(', ')}. Prefer risk_signal, objection, pain, goal or expansion_signal over status_quo or general when any fact supports it.
- summary: one plain sentence, at most 22 words, on where the topic stands NOW. When facts conflict, the newest wins ("Corwin cancelled, then reversed after talking to staff").
- Order topics by what a rep most needs to know before the next call.
${keep}
Then give EVERY fact, 0 to ${facts.length - 1}, one line in "facts": its topic label, and "same": the index of an earlier-listed fact it restates (the same fact said again, on another call or in other words), else null.

Facts:
${list}

Return ONLY JSON:
{"topics":[{"label":"Field Scanners","kind":"adoption","summary":"…"}],
 "facts":[{"i":0,"topic":"Field Scanners","same":null},{"i":1,"topic":"Field Scanners","same":0}]}`;
}

/** Parse the model's answer into topics over claim ids. A fact the model skipped joins Background. */
export function parseIntelTopics(text: string, facts: Note[]): IntelTopic[] | null {
  let obj: any;
  try {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    obj = JSON.parse(text.slice(s, e + 1));
  } catch { return null; }
  if (!Array.isArray(obj?.topics) || !Array.isArray(obj?.facts)) return null;
  const kinds = new Set(CLAIM_CATEGORY_KEYS as readonly string[]);
  const key = (l: unknown) => String(l ?? '').trim().replace(/\.$/, '').toLowerCase();
  const heads = new Map<string, { label: string; kind: string; summary: string }>();
  for (const t of obj.topics) {
    const label = String(t?.label ?? '').trim().replace(/\.$/, '').slice(0, 40);
    if (!label || heads.has(key(label))) continue;
    heads.set(key(label), { label, kind: kinds.has(String(t?.kind)) ? String(t.kind) : 'general', summary: String(t?.summary ?? '').trim().slice(0, 240) });
  }
  if (!heads.size) return null;
  if (!heads.has('background')) heads.set('background', { label: 'Background', kind: 'general', summary: '' });

  // Each fact's topic, and the fact it restates. A restatement follows its original's topic, so a
  // group never straddles two chips.
  const topicOf = new Array<string>(facts.length).fill('background');
  const same = new Array<number | null>(facts.length).fill(null);
  for (const r of obj.facts) {
    const i = Number(r?.i);
    if (!Number.isInteger(i) || i < 0 || i >= facts.length) continue;
    if (heads.has(key(r?.topic))) topicOf[i] = key(r.topic);
    const j = r?.same == null ? NaN : Number(r.same);
    if (Number.isInteger(j) && j >= 0 && j < facts.length && j !== i) same[i] = j;
  }
  const root = (i: number): number => { const seen = new Set<number>(); while (same[i] != null && !seen.has(i)) { seen.add(i); i = same[i] as number; } return i; };
  const groups = new Map<number, number[]>();
  facts.forEach((_, i) => { const r = root(i); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(i); });

  const byTopic = new Map<string, string[][]>();
  for (const [r, idxs] of groups) {
    // Newest first inside a group, so the first id is the one the page shows.
    idxs.sort((a, b) => (facts[b].created_at ?? '').localeCompare(facts[a].created_at ?? ''));
    const t = topicOf[r];
    if (!byTopic.has(t)) byTopic.set(t, []);
    byTopic.get(t)!.push(idxs.map(i => facts[i].id));
  }
  const out: IntelTopic[] = [];
  for (const [k, h] of heads) {
    const g = byTopic.get(k);
    if (g?.length) out.push({ ...h, facts: g });
  }
  // Background last, whatever order the model gave.
  out.sort((a, b) => Number(a.label.toLowerCase() === 'background') - Number(b.label.toLowerCase() === 'background'));
  return out.length ? out : null;
}

export async function loadIntelTopics(supabase: SupabaseClient, workspaceId: string, entityId: string): Promise<IntelTopicsRow | null> {
  const { data, error } = await supabase
    .from('intel_topics')
    .select('topics, fact_hash, fact_count, computed_at')
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .maybeSingle();
  // A missing table (migration not applied yet) reads as "no topics": the page shows plain chips.
  if (error) return null;
  return (data as IntelTopicsRow | null) ?? null;
}

export async function saveIntelTopics(
  supabase: SupabaseClient, workspaceId: string, entityId: string,
  row: { topics: IntelTopic[]; fact_hash: string; fact_count: number; model?: string | null },
): Promise<void> {
  const { error } = await supabase.from('intel_topics').upsert({
    workspace_id: workspaceId, entity_id: entityId, topics: row.topics, fact_hash: row.fact_hash,
    fact_count: row.fact_count, model: row.model ?? null, computed_at: new Date().toISOString(),
  }, { onConflict: 'workspace_id,entity_id' });
  if (error) throw error;
}

/**
 * Rebuild one record's topics when its fact set changed. `notes` is the record's full, unscoped
 * fact set (the account rollup for a company). `ask` sends one prompt and returns the text, or
 * null when the model failed — the caller owns the model door and the metering.
 * Returns 'fresh' (nothing changed), 'small' (too few facts), 'built' or 'failed'.
 */
export async function refreshIntelTopics(
  supabase: SupabaseClient, workspaceId: string, entityId: string, notes: Note[],
  ask: (prompt: string) => Promise<string | null>, opts: { model?: string | null; force?: boolean } = {},
): Promise<'fresh' | 'small' | 'built' | 'failed'> {
  const facts = topicFacts(notes);
  if (facts.length < INTEL_TOPICS_MIN_FACTS) return 'small';
  const hash = intelFactHash(facts);
  const current = await loadIntelTopics(supabase, workspaceId, entityId);
  if (!opts.force && current?.fact_hash === hash) return 'fresh';
  const text = await ask(buildIntelTopicsPrompt(facts, current?.topics ?? []));
  const topics = text ? parseIntelTopics(text, facts) : null;
  if (!topics) return 'failed';
  await saveIntelTopics(supabase, workspaceId, entityId, { topics, fact_hash: hash, fact_count: facts.length, model: opts.model });
  return 'built';
}
