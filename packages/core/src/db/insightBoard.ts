import type { SupabaseClient } from '@supabase/supabase-js';
import { getInternalEntityIds, getInternalIdentities } from './teamMembers.js';
import { loadOwnDomains } from './workspaceDomains.js';
import { emailDomain, isFreeEmailDomain } from '../utils/identity.js';

// The Insights board — every customer insight under exactly one button, grouped by the concrete
// thing it is about, and tied to the account that said it.
//
// Two questions, asked once each:
//   WHO HAS TO ACT      the lane: product, sales, customer success, or market (know, don't fix)
//   WHAT KIND OF WORK   the subtype inside that lane (bug, friction, feature request, …)
// and one grouping key: the TAG, a concrete thing from the workspace's own list (QR code, CRM
// integration). A board row is (subtype × tag).
//
// WHY ONE PASS. The page this replaces multiplied two labels that were chosen separately — the
// extractor's category (Product / Positioning / Market / Buyer) and a later action label — and
// the combinations stopped meaning anything: "Buyer · Product issue" held "reps never adopt
// tools they haven't been shown", which is a training problem. Here one read of the sentence
// picks the button, so each insight has one home and each home has an owner.

export type BoardLane = 'product' | 'sales' | 'success' | 'market';

export interface InsightSubtypeDef {
  key: string;
  lane: BoardLane;
  label: string;
  /** Used in the sorting prompt. What someone would have to DO, not what the sentence mentions. */
  definition: string;
}

export const BOARD_LANES: { key: BoardLane; label: string }[] = [
  { key: 'product', label: 'Product' },
  { key: 'sales', label: 'Sales' },
  { key: 'success', label: 'Customer success' },
  { key: 'market', label: 'Market' },
];

export const INSIGHT_SUBTYPES: InsightSubtypeDef[] = [
  { key: 'bug', lane: 'product', label: 'Bug', definition: 'something in our product is broken or fails' },
  { key: 'friction', lane: 'product', label: 'Friction', definition: 'it works, but it is manual, slow, clunky or confusing to use' },
  { key: 'feature', lane: 'product', label: 'Feature request', definition: 'they want a capability we do not have' },
  { key: 'objection', lane: 'sales', label: 'Objection', definition: 'a reason the BUYER gives against buying, switching or renewing with us (trust, risk, timing, "we already have X"), other than price. Their pushback, in their words; not a fact about how the work goes, not a wish' },
  { key: 'pricing', lane: 'sales', label: 'Pricing', definition: 'cost, fees, per-use charges, discounts, value for money' },
  { key: 'pitch', lane: 'sales', label: 'Pitch & messaging', definition: 'the buyer misunderstood or questioned what we are or do, or reacted to how we framed it' },
  { key: 'setup', lane: 'success', label: 'Setup', definition: 'getting it running: install, integrations to switch on, logins, access, provisioning' },
  { key: 'training', lane: 'success', label: 'Training & adoption', definition: 'staff not using it, needing training, materials, champions or follow-up' },
  { key: 'partners', lane: 'market', label: 'Competitors & partners', definition: 'other vendors and incumbent tools, partners, and the rules they set; a fact to know, nothing to fix' },
  { key: 'buyers', lane: 'market', label: 'Who buys', definition: 'roles, decision makers, customer segments and how customers operate; a fact to know, nothing to fix' },
];

// ── What the business sells decides what the board's buttons mean (A/B) ─────────────────────
// A software company's customers report bugs and ask for features. An agency's clients have no
// product to break: they get results or they do not, the work is smooth or it is not, and they ask
// for a service we do not offer. Same ten keys either way — rows, charts and stored placements stay
// comparable — but the labels and the definitions the sorter reads follow the business.
export type BusinessType = 'software' | 'service';

const SERVICE_LANES: Partial<Record<BoardLane, string>> = { product: 'Delivery', success: 'Client success' };
const SERVICE_SUBTYPES: Record<string, { label: string; definition: string }> = {
  bug: { label: 'Missed results', definition: 'the work we delivered fell short: results, lead or meeting quality, errors, missed commitments or deadlines' },
  friction: { label: 'Process friction', definition: 'working with us is slow, manual, unclear or needs chasing: handoffs, approvals, back-and-forth' },
  feature: { label: 'Service request', definition: 'they want something we do not offer yet: a channel, deliverable, report, integration or add-on' },
  setup: { label: 'Onboarding', definition: 'getting started with us: access, accounts, assets, domains, kickoff, first campaign' },
  training: { label: 'Reporting & communication', definition: 'how we keep them informed: updates, reporting, visibility into the work, responsiveness' },
};

export function boardTaxonomy(bt: BusinessType = 'software'): {
  lanes: { key: BoardLane; label: string }[]; subtypes: InsightSubtypeDef[];
} {
  if (bt !== 'service') return { lanes: BOARD_LANES, subtypes: INSIGHT_SUBTYPES };
  return {
    lanes: BOARD_LANES.map(l => ({ ...l, label: SERVICE_LANES[l.key] ?? l.label })),
    subtypes: INSIGHT_SUBTYPES.map(s => ({ ...s, ...(SERVICE_SUBTYPES[s.key] ?? {}) })),
  };
}

/** What this workspace sells: the answer someone gave (onboarding, or the Insights filter), else
 *  software. NOT workspaces.industry: it defaults to "agency" on every workspace, so reading it made
 *  a customer — a software company — an agency with a Delivery tab. */
export async function loadBusinessType(supabase: SupabaseClient, workspaceId: string): Promise<BusinessType> {
  const { data } = await supabase.from('workspaces').select('business_type').eq('id', workspaceId).maybeSingle();
  const bt = (data as { business_type?: string | null } | null)?.business_type;
  return bt === 'service' ? 'service' : 'software';
}

/** Record what the workspace sells. It decides the board's buttons, so it is a person's answer. */
export async function saveBusinessType(supabase: SupabaseClient, workspaceId: string, bt: BusinessType): Promise<void> {
  const { error } = await supabase.from('workspaces').update({ business_type: bt }).eq('id', workspaceId);
  if (error) throw error;
}

/** The sorter's escape hatch (C): not the customer's own view. Stored as sorted with no button. */
export const NOT_AN_INSIGHT = 'none';

const SUBTYPE_BY_KEY = new Map(INSIGHT_SUBTYPES.map(s => [s.key, s]));
export const laneOfSubtype = (key: string): BoardLane | null => SUBTYPE_BY_KEY.get(key)?.lane ?? null;
export const isInsightSubtype = (key: unknown): key is string => typeof key === 'string' && SUBTYPE_BY_KEY.has(key);

/** A row is named and summarised once this many separate accounts raised it. One: every topic gets
 *  a name that says what it is (D). Before, below three a row showed only its tag ("Outbound
 *  agency"), which names what an objection is ABOUT, not the objection. */
export const BOARD_SUMMARY_MIN_ACCOUNTS = 1;

/** Below this many accounts a topic is named from its own clearest sentence, with no model call: one
 *  account's one or two statements already say what the topic is. Most topics are this small. */
export const BOARD_MODEL_NAME_MIN_ACCOUNTS = 2;

/** Topics named per model call. The instructions and the company description are sent once per
 *  batch, not once per topic. */
export const BOARD_NAME_BATCH = 10;

/** Rewrite a row's summary when its membership has grown enough to change the story: first time,
 *  or 25% more insights and at least three new ones since it was written. */
export function rowNeedsSummary(summarizedCount: number, currentCount: number): boolean {
  if (!summarizedCount) return currentCount > 0;
  return currentCount - summarizedCount >= 3 && currentCount >= summarizedCount * 1.25;
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const whoWeAre = (ctx?: string | null) => {
  const c = (ctx || '').trim();
  return c ? `WHO WE ARE (the company these insights are about):\n"""\n${c.slice(0, 2500)}\n"""\n\n` : '';
};
const itemLine = (s: { statement: string; quote?: string | null }, i: number) =>
  `${i}. ${s.statement}${s.quote ? ` — "${s.quote}"` : ''}`;

/** Propose the tags a list is missing. `existing` empty = first run, propose the whole list. */
export function buildTagListPrompt(
  statements: string[],
  existing: { name: string; definition: string | null }[],
  workspaceContext?: string | null,
): string {
  const have = existing.length
    ? `The workspace already has these tags. Propose ONLY what is missing:\n${existing.map(t => `- ${t.name}: ${t.definition ?? ''}`).join('\n')}\n\n`
    : '';
  const size = existing.length ? 'at most 10 new tags; none if the list already covers them' : '25 to 60 tags';
  return `${whoWeAre(workspaceContext)}A head of product groups customer feedback by TAG. ${have}Below are ${statements.length} things customers said.

A tag names a concrete THING a person would search for: a feature, module, integration, channel, competitor, buyer role, customer segment or workflow step. Good: "QR code", "SMS campaigns", "CRM integration", "Trade-in tool". Bad: lessons, sentiments or abstractions ("adoption", "friction", "value", "trust").

Rules:
- Propose ${size}.
- A competitor, vendor, partner, tool or data provider that is NAMED gets its own tag, named exactly as it is called ("Ledgerwise", "Pricebook Pro", "Creditlane"). Never fold a named company into a theme ("Credit qualification") or into another company's tag: the board groups what was said about each one under its name.
- A capability customers ask for gets a tag naming the capability itself ("QR code check-in"), not the area it sits in ("Showroom").
- Named companies need at least 2 statements naming them; everything else at least 3.
- Name: 1 to 3 words, in the words the business itself uses. Definition: one line. Aliases: other words customers use for it.
- Split a tag only when the two halves would have different owners; merge near-duplicates.

Statements:
${statements.map((s, i) => `${i}. ${s}`).join('\n')}

Output ONLY JSON: {"tags":[{"name":"QR code","definition":"one line","aliases":["qr"]}]}`;
}

export interface ProposedTag { name: string; definition: string | null; aliases: string[] }

export function parseTagList(text: string): ProposedTag[] | null {
  const obj = parseObject(text);
  if (!obj || !Array.isArray(obj.tags)) return null;
  const out: ProposedTag[] = [];
  const seen = new Set<string>();
  for (const t of obj.tags as unknown[]) {
    const r = t as { name?: unknown; definition?: unknown; aliases?: unknown };
    const name = typeof r?.name === 'string' ? r.name.trim() : '';
    if (!name || name.length > 40 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({
      name,
      definition: typeof r.definition === 'string' ? r.definition.trim() : null,
      aliases: Array.isArray(r.aliases) ? r.aliases.filter((a): a is string => typeof a === 'string').slice(0, 8) : [],
    });
  }
  return out;
}

/** Place each insight: one subtype, 1-3 tags from the list. */
export function buildSortPrompt(
  items: { statement: string; quote?: string | null }[],
  tags: { name: string; definition: string | null; aliases?: string[] }[],
  workspaceContext?: string | null,
  bt: BusinessType = 'software',
): string {
  const tax = boardTaxonomy(bt);
  const buttons = tax.subtypes.map(s => `- ${s.key} (${tax.lanes.find(l => l.key === s.lane)!.label} → ${s.label}) = ${s.definition}`).join('\n')
    + `\n- ${NOT_AN_INSIGHT} = NOT the customer's own view: something our side said or pitched, a general fact about the market or how the work goes with no stance from them, logistics, small talk`;
  const sells = bt === 'service'
    ? 'We sell a SERVICE (we do the work for them), not a software product: there is no product to have bugs or features; judge what they say about the work we deliver.\n\n'
    : '';
  const tagList = tags.map(t => `- ${t.name}: ${t.definition ?? ''}${t.aliases?.length ? ` (also: ${t.aliases.join(', ')})` : ''}`).join('\n');
  return `${whoWeAre(workspaceContext)}${sells}Each statement below was extracted from a conversation with a customer or prospect. For each one decide two things.

1. "b": the ONE button it goes under: the team that has to act, and the kind of work.
${buttons}
Decide by what someone on our side would have to DO. A complaint about training goes to training even when it names a feature. Something of ours that fails is a bug even when a buyer said it. Use a market button only when nothing needs fixing: it is a fact to know.
Only the buyer's own stance counts: what they want, fear, object to, complain about, or tell us about themselves. If the statement is really our pitch, a claim about how outbound or the market works, or anything that is not the buyer's view, use "${NOT_AN_INSIGHT}". When unsure between a button and "${NOT_AN_INSIGHT}", choose "${NOT_AN_INSIGHT}".

2. "tags": 1 to 3 tags copied exactly from this list, most specific first. The FIRST tag is what the statement is grouped under, so: if it names a competitor, vendor or tool, that company's tag goes first; if it asks for a capability, the capability's tag goes first. If none fits, [] and put a proposed tag in "new_tag" (a named company as its name).
${tagList}

Statements:
${items.map(itemLine).join('\n')}

Output ONLY JSON, one entry per statement: {"items":[{"i":0,"b":"bug","tags":["QR code"],"new_tag":null}]}`;
}

export interface SortedInsight { subtype: string; tags: string[]; newTag: string | null }

/** Parse a sort answer against the batch it was asked about. Unknown buttons and tags that are not
 *  on the list are dropped, never guessed. Returns null when the answer cannot be read at all. */
export function parseSortAnswer(text: string, count: number, tagNames: string[]): (SortedInsight | null)[] | null {
  const obj = parseObject(text);
  if (!obj || !Array.isArray(obj.items)) return null;
  const valid = new Map(tagNames.map(n => [n.toLowerCase(), n]));
  const out: (SortedInsight | null)[] = new Array(count).fill(null);
  for (const a of obj.items as unknown[]) {
    const r = a as { i?: unknown; b?: unknown; tags?: unknown; new_tag?: unknown };
    const i = Number(r?.i);
    if (!Number.isInteger(i) || i < 0 || i >= count || out[i]) continue;
    if (r.b === NOT_AN_INSIGHT) { out[i] = { subtype: NOT_AN_INSIGHT, tags: [], newTag: null }; continue; }
    if (!isInsightSubtype(r.b)) continue;
    const tags = (Array.isArray(r.tags) ? r.tags : [])
      .map(t => (typeof t === 'string' ? valid.get(t.trim().toLowerCase()) : undefined))
      .filter((t): t is string => !!t);
    out[i] = { subtype: r.b, tags: [...new Set(tags)].slice(0, 3), newTag: typeof r.new_tag === 'string' && r.new_tag.trim() ? r.new_tag.trim() : null };
  }
  return out;
}

/** One board row: what the problem is, the concrete problems inside it, and the best quotes. */
export function buildRowSummaryPrompt(
  tagName: string,
  subtypeKey: string,
  items: { statement: string; quote?: string | null; account?: string | null; date?: string | null }[],
  workspaceContext?: string | null,
  bt: BusinessType = 'software',
): string {
  const tax = boardTaxonomy(bt);
  const st = tax.subtypes.find(s => s.key === subtypeKey);
  const lane = tax.lanes.find(l => l.key === st?.lane)?.label ?? '';
  return `${whoWeAre(workspaceContext)}Below are ${items.length} things customers said about "${tagName}", all classified as ${lane} → ${st?.label ?? subtypeKey} (${st?.definition ?? ''}).

Give the team that owns this the short version, using only what these statements say:
- "headline": one plain sentence, max 16 words, that NAMES the ${st?.label?.toLowerCase() ?? 'insight'} itself in the customer's terms: for an objection, the objection ("Buyers fear losing control when they outsource acquisition"); for a request, what they want. Not the topic's name, not advice.
- "problems": the 1 to 3 distinct concrete problems inside this set, biggest first. Each has a "title" (max 9 words; name the system, step or symptom), a one-line "detail" (max 22 words), and "items": the statement numbers that belong to it. Every statement goes into at most one problem.
- "receipts": the 3 statement numbers that best prove the headline, from different accounts where possible, preferring ones with a verbatim quote.

Statements:
${items.map((it, i) => `${itemLine(it, i)} (${it.account || 'unknown account'}${it.date ? ', ' + it.date : ''})`).join('\n')}

Output ONLY JSON: {"headline":"...","problems":[{"title":"...","detail":"...","items":[0,3]}],"receipts":[0,5,9]}`;
}

export interface RowSummary { headline: string; problems: { title: string; detail: string; items: number[] }[]; receipts: number[] }

export function parseRowSummary(text: string, count: number): RowSummary | null {
  const obj = parseObject(text);
  if (!obj || typeof obj.headline !== 'string' || !obj.headline.trim()) return null;
  const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < count;
  const used = new Set<number>();
  const problems = (Array.isArray(obj.problems) ? obj.problems : []).slice(0, 3).map((p: unknown) => {
    const r = p as { title?: unknown; detail?: unknown; items?: unknown };
    // One statement, one problem: a later problem cannot claim what an earlier one already holds.
    const items = [...new Set((Array.isArray(r.items) ? r.items : []).map(Number).filter(ok))].filter(n => !used.has(n));
    items.forEach(n => used.add(n));
    return { title: typeof r.title === 'string' ? r.title.trim() : '', detail: typeof r.detail === 'string' ? r.detail.trim() : '', items };
  }).filter(p => p.title && p.items.length);
  const receipts = [...new Set((Array.isArray(obj.receipts) ? obj.receipts : []).map(Number).filter(ok))].slice(0, 3);
  return { headline: obj.headline.trim(), problems, receipts };
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const t = String(text || '');
    const s = t.indexOf('{'), e = t.lastIndexOf('}');
    if (s === -1 || e <= s) return null;
    const v = JSON.parse(t.slice(s, e + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// ── Accounts ─────────────────────────────────────────────────────────────────

/**
 * The observation refs a call leaves behind, for an insight's ref. Fellow files one observation per
 * attendee as `source://fellow/fellow_<id>_<entityId>` while the insight carries
 * `source://fellow/<id>`; other sources use the same ref on both. Pure, for the tests.
 */
export function observationRefPattern(insightRef: string): { eq: string; like: string | null } {
  const m = /^source:\/\/([a-z0-9_-]+)\/(.+)$/i.exec(insightRef || '');
  if (!m) return { eq: insightRef, like: null };
  const [, system, id] = m;
  // The call id anywhere in the ref, within the same tool. Pipelines wrap it differently:
  // `fellow_<id>_<n>`, `fathom_<id>_<contact>`, and Fireflies action items as
  // `action_item_fireflies_<id>_<n>` — which the old `<system>_<id>_%` missed, so 83 of 90
  // OpenNous insights were never tied to an account and the board said nobody raised them.
  return { eq: insightRef, like: `source://${system}/%${id}%` };
}

/**
 * Which account said it: the call's external attendees → the company they work at. Our own people
 * are skipped, so our own company never shows up as the account. Returns ref → {contactId, companyId}.
 */
export async function resolveInsightAccounts(
  supabase: SupabaseClient,
  workspaceId: string,
  refs: string[],
  internalIds: Set<string>,
): Promise<Map<string, { contactId: string | null; companyId: string | null }>> {
  const out = new Map<string, { contactId: string | null; companyId: string | null }>();
  const people = new Map<string, string[]>();
  for (const ref of [...new Set(refs.filter(Boolean))]) {
    const p = observationRefPattern(ref);
    // Quoted: a ref is full of ':' and '/', which PostgREST's filter grammar would otherwise split on.
    const filter = p.like ? `source_ref.eq."${p.eq}",source_ref.like."${p.like}"` : `source_ref.eq."${p.eq}"`;
    const { data } = await supabase.from('observations').select('entity_id')
      .eq('workspace_id', workspaceId).or(filter).limit(50);
    people.set(ref, [...new Set(((data as { entity_id: string }[] | null) ?? []).map(o => o.entity_id))].filter(id => !internalIds.has(id)));
  }
  const all = [...new Set([...people.values()].flat())];
  const worksAt = new Map<string, string>();
  for (let i = 0; i < all.length; i += 60) {
    const { data } = await supabase.from('relationships').select('from_entity_id, to_entity_id')
      .eq('workspace_id', workspaceId).eq('type', 'works_at').is('valid_to', null)
      .in('from_entity_id', all.slice(i, i + 60));
    for (const r of (data as { from_entity_id: string; to_entity_id: string }[] | null) ?? []) worksAt.set(r.from_entity_id, r.to_entity_id);
  }
  for (const [ref, ids] of people) {
    // The company most of the call's outside attendees work at; a person with no company still
    // counts as the contact.
    const counts = new Map<string, number>();
    for (const id of ids) { const c = worksAt.get(id); if (c) counts.set(c, (counts.get(c) || 0) + 1); }
    const companyId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const contactId = ids.find(id => worksAt.get(id) === companyId) ?? ids[0] ?? null;
    out.set(ref, { contactId, companyId });
  }
  return out;
}

// ── Store ────────────────────────────────────────────────────────────────────

export interface InsightTagRow { id: string; name: string; definition: string | null; aliases: string[]; origin: string }
export interface InsightBoardRow {
  id: string; subtype: string; tag_id: string; headline: string | null;
  problems: { title: string; detail: string; item_ids: string[] }[];
  receipt_ids: string[]; item_count: number; account_count: number; summarized_at: string | null;
}
export interface BoardItem {
  id: string; statement: string; quote: string | null; speaker: string | null; occurred_at: string | null;
  source_ref: string | null; subtype: string | null; tag_ids: string[]; company_id: string | null; category: string;
  speaker_id?: string | null; contact_id?: string | null;
}

const PAGE = 1000;

export async function listInsightTags(supabase: SupabaseClient, workspaceId: string): Promise<InsightTagRow[]> {
  const { data, error } = await supabase.from('insight_tags').select('id, name, definition, aliases, origin')
    .eq('workspace_id', workspaceId).is('retired_at', null).order('name');
  if (error) throw error;
  return (data as InsightTagRow[]) ?? [];
}

/** Add model-proposed tags. A name the workspace already has (in any case) is left alone. */
export async function addInsightTags(supabase: SupabaseClient, workspaceId: string, tags: ProposedTag[]): Promise<number> {
  if (!tags.length) return 0;
  // Uniqueness is on lower(name), an expression PostgREST cannot target as a conflict key, so the
  // check happens here. Retired names count as taken: a person retired them on purpose.
  const { data: have, error: readErr } = await supabase.from('insight_tags').select('name').eq('workspace_id', workspaceId);
  if (readErr) throw readErr;
  const taken = new Set(((have as { name: string }[] | null) ?? []).map(t => t.name.toLowerCase()));
  const fresh = tags.filter(t => !taken.has(t.name.toLowerCase()));
  if (!fresh.length) return 0;
  const { data, error } = await supabase.from('insight_tags')
    .insert(fresh.map(t => ({ workspace_id: workspaceId, name: t.name, definition: t.definition, aliases: t.aliases, origin: 'model' })))
    .select('id');
  if (error) throw error;
  return (data as unknown[] | null)?.length ?? 0;
}

/** External insights the board has not placed yet, oldest first. */
export async function listUnsortedInsightItems(supabase: SupabaseClient, workspaceId: string, limit = 2000): Promise<BoardItem[]> {
  const out: BoardItem[] = [];
  for (let from = 0; out.length < limit; from += PAGE) {
    const { data, error } = await supabase.from('insight_items')
      .select('id, statement, quote, speaker, speaker_id, contact_id, occurred_at, source_ref, subtype, tag_ids, company_id, category')
      .eq('workspace_id', workspaceId).eq('source', 'external').is('sorted_at', null)
      .order('created_at', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...((data as BoardItem[]) ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out.slice(0, limit);
}

/** Every placed external insight: what the board and the nightly summaries read. */
export async function listBoardItems(supabase: SupabaseClient, workspaceId: string): Promise<BoardItem[]> {
  const out: BoardItem[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('insight_items')
      .select('id, statement, quote, speaker, speaker_id, contact_id, occurred_at, source_ref, subtype, tag_ids, company_id, category')
      .eq('workspace_id', workspaceId).eq('source', 'external').not('subtype', 'is', null)
      .order('id').range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...((data as BoardItem[]) ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export async function saveInsightPlacement(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
  p: { subtype: string; tagIds: string[]; contactId: string | null; companyId: string | null },
): Promise<void> {
  const none = p.subtype === NOT_AN_INSIGHT;
  const { error } = await supabase.from('insight_items').update({
    // Not an insight: sorted (so it is never asked about again) and on no button, so the board skips it.
    subtype: none ? null : p.subtype, lane: none ? null : laneOfSubtype(p.subtype), tag_ids: none ? [] : p.tagIds,
    contact_id: p.contactId, company_id: p.companyId, sorted_at: new Date().toISOString(),
  }).eq('workspace_id', workspaceId).eq('id', id);
  if (error) throw error;
}

export async function listInsightRows(supabase: SupabaseClient, workspaceId: string): Promise<InsightBoardRow[]> {
  const { data, error } = await supabase.from('insight_rows')
    .select('id, subtype, tag_id, headline, problems, receipt_ids, item_count, account_count, summarized_at')
    .eq('workspace_id', workspaceId);
  if (error) throw error;
  return (data as InsightBoardRow[]) ?? [];
}

export async function saveInsightRow(
  supabase: SupabaseClient,
  workspaceId: string,
  row: Omit<InsightBoardRow, 'id' | 'summarized_at'>,
): Promise<void> {
  const { error } = await supabase.from('insight_rows').upsert({
    workspace_id: workspaceId, ...row, summarized_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, { onConflict: 'workspace_id,subtype,tag_id' });
  if (error) throw error;
}

/** Company display names, for the evidence lines. */
export async function companyNames(supabase: SupabaseClient, workspaceId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 100) {
    const { data } = await supabase.from('claims').select('entity_id, value')
      .eq('workspace_id', workspaceId).eq('property', 'name').is('invalid_at', null)
      .in('entity_id', uniq.slice(i, i + 100));
    for (const c of (data as { entity_id: string; value: unknown }[] | null) ?? []) {
      if (typeof c.value === 'string' && !out.has(c.entity_id)) out.set(c.entity_id, c.value);
    }
  }
  return out;
}

// ── What the team decided about a topic ──────────────────────────────────────
// Status, priority and notes (supabase/migrations/2026_09_25_insight_topic_state.sql). Separate
// from insight_rows on purpose: nothing here can reach the text the worker wrote.

export const TOPIC_STATUSES = ['new', 'aware', 'in_progress', 'shipped', 'fixed', 'wont_do'] as const;
export const TOPIC_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export interface TopicState {
  topic_key: string; status: typeof TOPIC_STATUSES[number]; priority: typeof TOPIC_PRIORITIES[number] | null;
  notes: string; updated_by: string | null; updated_at: string;
}

export async function listTopicStates(supabase: SupabaseClient, workspaceId: string): Promise<TopicState[]> {
  const { data, error } = await supabase.from('insight_topic_state')
    .select('topic_key, status, priority, notes, updated_by, updated_at').eq('workspace_id', workspaceId);
  if (error) throw error;
  return (data as TopicState[]) ?? [];
}

/** Change any of status, priority or notes on one topic; fields left out keep their value. */
export async function saveTopicState(
  supabase: SupabaseClient, workspaceId: string, topicKey: string,
  patch: { status?: TopicState['status']; priority?: TopicState['priority']; notes?: string }, userId: string | null,
): Promise<TopicState> {
  const row: Record<string, unknown> = { workspace_id: workspaceId, topic_key: topicKey, updated_by: userId, updated_at: new Date().toISOString() };
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.priority !== undefined) row.priority = patch.priority;
  if (patch.notes !== undefined) row.notes = patch.notes.slice(0, 50_000);
  const { data, error } = await supabase.from('insight_topic_state').upsert(row, { onConflict: 'workspace_id,topic_key' })
    .select('topic_key, status, priority, notes, updated_by, updated_at').single();
  if (error) throw error;
  return data as TopicState;
}

// ── A recommendation for one topic ───────────────────────────────────────────
// Written on request from the topic's own insights, cited by conversation, stored read-only
// (supabase/migrations/2026_09_25_insight_topic_notes.sql).

export interface TopicRecommendation {
  summary: string;
  actions: { title: string; detail: string; sources: number[] }[];
  refs: string[];
  item_count: number;
  created_at: string;
}

export async function getTopicRecommendation(supabase: SupabaseClient, workspaceId: string, topicKey: string): Promise<TopicRecommendation | null> {
  const { data, error } = await supabase.from('insight_topic_recommendations')
    .select('summary, actions, refs, item_count, created_at')
    .eq('workspace_id', workspaceId).eq('topic_key', topicKey).maybeSingle();
  if (error) throw error;
  return (data as TopicRecommendation | null) ?? null;
}

export async function saveTopicRecommendation(
  supabase: SupabaseClient, workspaceId: string, topicKey: string, rec: Omit<TopicRecommendation, 'created_at'>,
): Promise<TopicRecommendation> {
  const { data, error } = await supabase.from('insight_topic_recommendations').upsert({
    workspace_id: workspaceId, topic_key: topicKey, ...rec, created_at: new Date().toISOString(),
  }, { onConflict: 'workspace_id,topic_key' }).select('summary, actions, refs, item_count, created_at').single();
  if (error) throw error;
  return data as TopicRecommendation;
}

/** One topic's insights grouped by conversation, newest first: the numbering the prompt cites by. */
export function topicSources(items: BoardItem[]): { ref: string; items: BoardItem[] }[] {
  const keyOf = (i: BoardItem) => i.source_ref || (i.occurred_at || '').slice(0, 10) || i.id;
  const sorted = [...items].sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')));
  const by = new Map<string, BoardItem[]>();
  for (const it of sorted) { const k = keyOf(it); if (!by.has(k)) by.set(k, []); by.get(k)!.push(it); }
  return [...by.entries()].map(([ref, its]) => ({ ref, items: its }));
}

export function buildRecommendationPrompt(
  topic: string, subtypeKey: string, sources: { items: { statement: string; quote?: string | null; account?: string | null; date?: string | null }[] }[],
  workspaceContext?: string | null,
): string {
  const st = SUBTYPE_BY_KEY.get(subtypeKey);
  const lane = BOARD_LANES.find(l => l.key === st?.lane)?.label ?? '';
  const lines = sources.map((s, n) => s.items.slice(0, 4).map((it) =>
    `[${n + 1}] ${it.statement}${it.quote ? ` — "${it.quote}"` : ''} (${it.account || 'unknown account'}${it.date ? ', ' + it.date : ''})`).join('\n')).join('\n');
  return `${whoWeAre(workspaceContext)}Customers raised "${topic}" (${lane} → ${st?.label ?? subtypeKey}: ${st?.definition ?? ''}). Every statement below is numbered by the conversation it came from.

Recommend what the team that owns this should do about it, using ONLY what these statements say. Be concrete and specific to what was said; no generic advice, no invented numbers.
- "summary": 2 or 3 sentences: what to do and why, citing conversations inline as [n].
- "actions": 1 to 3 next steps, most important first. Each has a "title" (max 8 words, starts with a verb), a "detail" (one sentence, max 28 words) and "sources": the conversation numbers that justify it.

Statements:
${lines}

Output ONLY JSON: {"summary":"... [1] ... [4]","actions":[{"title":"...","detail":"...","sources":[1,4]}]}`;
}

export function parseRecommendation(text: string, sourceCount: number): { summary: string; actions: { title: string; detail: string; sources: number[] }[] } | null {
  const obj = parseObject(text);
  if (!obj || typeof obj.summary !== 'string' || !obj.summary.trim()) return null;
  const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= sourceCount;
  // A marker that points past the sources would be a citation to nothing: drop it from the text.
  const summary = obj.summary.trim().replace(/\[(\d+)\]/g, (m: string, d: string) => (ok(Number(d)) ? m : ''));
  const actions = (Array.isArray(obj.actions) ? obj.actions : []).slice(0, 3).map((a: unknown) => {
    const r = a as { title?: unknown; detail?: unknown; sources?: unknown };
    return {
      title: String(r.title ?? '').trim().slice(0, 120),
      detail: String(r.detail ?? '').trim().slice(0, 400),
      sources: [...new Set((Array.isArray(r.sources) ? r.sources : []).filter(ok))].sort((x, y) => x - y),
    };
  }).filter((a: { title: string }) => a.title);
  return { summary, actions };
}

// ── Whose words: customers only ──────────────────────────────────────────────
// The board is the customer's voice. A line our own team said on a call — a founder describing
// their own doubts, a rep's pitch — is not a customer insight however it was filed, and it must not
// be ranked, summarised or quoted as one.
//
// Speakers arrive as a name ("Marten Oakshaw"), sometimes an email, and on older insights as the
// meeting's title ("Networking Call between Theo Bramwell and Marten Oakshaw"). Team members are
// often known only by their login email, so matching the internal ENTITIES alone misses them: the
// member's own name, from their seat, is what the transcript actually says.

export interface InternalSpeakers { ids: Set<string>; names: Set<string>; emails: Set<string>; domains: Set<string> }

const normName = (s: string | null | undefined) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export async function loadInternalSpeakers(supabase: SupabaseClient, workspaceId: string): Promise<InternalSpeakers> {
  const [identities, entityIds, ownDomains] = await Promise.all([
    getInternalIdentities(supabase, workspaceId).catch(() => []),
    getInternalEntityIds(supabase, workspaceId).catch(() => new Set<string>()),
    loadOwnDomains(supabase, workspaceId).catch(() => new Set<string>()),
  ]);
  const emails = new Set(identities.filter(i => i.kind === 'email').map(i => i.value.toLowerCase()));
  const names = new Set(identities.map(i => normName(i.label)).filter(n => n.length >= 3));
  const domains = new Set(ownDomains);
  // A member's corporate address names the company's domain even before anyone registered it.
  for (const e of emails) { const d = emailDomain(e); if (d && !isFreeEmailDomain(d)) domains.add(d); }

  const ids = new Set(entityIds);
  if (emails.size) {
    const { data } = await supabase.from('entity_identifiers').select('entity_id')
      .eq('workspace_id', workspaceId).eq('kind', 'email').in('value', [...emails]);
    for (const r of (data as { entity_id: string }[] | null) ?? []) ids.add(r.entity_id);
  }
  if (ids.size) {
    const list = [...ids];
    for (let i = 0; i < list.length; i += 100) {
      const { data } = await supabase.from('claims').select('entity_id, property, value')
        .eq('workspace_id', workspaceId).in('entity_id', list.slice(i, i + 100)).in('property', ['name', 'first_name', 'last_name']).is('invalid_at', null);
      const parts = new Map<string, Record<string, string>>();
      for (const c of (data as { entity_id: string; property: string; value: unknown }[] | null) ?? []) {
        if (typeof c.value !== 'string') continue;
        const m = parts.get(c.entity_id) ?? {}; m[c.property] = c.value; parts.set(c.entity_id, m);
      }
      for (const m of parts.values()) {
        const full = normName(m.name || [m.first_name, m.last_name].filter(Boolean).join(' '));
        if (full.length >= 3) names.add(full);
      }
    }
  }
  return { ids, names, emails, domains };
}

/** Did one of our own people say this? */
export function isInternalSpeaker(
  it: { speaker?: string | null; speaker_id?: string | null; contact_id?: string | null },
  s: InternalSpeakers,
): boolean {
  if (it.speaker_id && s.ids.has(it.speaker_id)) return true;
  if (it.contact_id && s.ids.has(it.contact_id)) return true;
  const sp = normName(it.speaker);
  if (!sp) return false;
  if (s.names.has(sp)) return true;
  if (sp.includes('@')) {
    if (s.emails.has(sp)) return true;
    const d = emailDomain(sp);
    if (d && s.domains.has(d)) return true;
  }
  // A meeting title in the speaker slot that names one of us ("Networking Call between Theo
  // Bramwell and Marten Oakshaw"). Full names only, so a first name shared with a customer
  // ("Ignatius <> Morwenna") is not enough.
  for (const n of s.names) if (n.includes(' ') && sp.includes(n)) return true;
  return false;
}

/** Take every external insight off the board so the next run sorts it again (after the buttons or
 *  the rules changed). Tags are kept; row summaries are dropped so every row is named afresh. */
export async function unsortWorkspaceInsights(supabase: SupabaseClient, workspaceId: string): Promise<void> {
  const { error } = await supabase.from('insight_items').update({ subtype: null, lane: null, tag_ids: [], sorted_at: null })
    .eq('workspace_id', workspaceId).eq('source', 'external');
  if (error) throw error;
  const { error: rowsErr } = await supabase.from('insight_rows').delete().eq('workspace_id', workspaceId);
  if (rowsErr) throw rowsErr;
}

/** Remove the tags the model proposed, so the next run proposes a list under the current rules.
 *  Tags a person made or renamed (origin 'human') are kept. Run only after unsortWorkspaceInsights:
 *  nothing may still point at a removed tag. */
export async function dropModelTags(supabase: SupabaseClient, workspaceId: string): Promise<void> {
  const { error } = await supabase.from('insight_tags').delete().eq('workspace_id', workspaceId).eq('origin', 'model');
  if (error) throw error;
}

// ── Naming several topics in one call ────────────────────────────────────────
export function buildRowsSummaryPrompt(
  rows: { tagName: string; subtypeKey: string; items: { statement: string; quote?: string | null; account?: string | null; date?: string | null }[] }[],
  workspaceContext?: string | null,
  bt: BusinessType = 'software',
): string {
  const tax = boardTaxonomy(bt);
  const blocks = rows.map((r, k) => {
    const st = tax.subtypes.find(s => s.key === r.subtypeKey);
    const lane = tax.lanes.find(l => l.key === st?.lane)?.label ?? '';
    return `### Topic ${k}: "${r.tagName}" — ${lane} → ${st?.label ?? r.subtypeKey} (${st?.definition ?? ''})
${r.items.map((it, i) => `${itemLine(it, i)} (${it.account || 'unknown account'}${it.date ? ', ' + it.date : ''})`).join('\n')}`;
  }).join('\n\n');
  return `${whoWeAre(workspaceContext)}Below are ${rows.length} topics, each with the things customers said about it. For EACH topic, using only its own statements:
- "headline": one plain sentence, max 16 words, that NAMES the thing itself in the customer's terms: for an objection, the objection; for a request, what they want; for a competitor, what they said about it. Not the topic's name, not advice.
- "problems": the 1 to 3 distinct concrete problems inside it, biggest first. Each has a "title" (max 9 words), a one-line "detail" (max 22 words), and "items": that topic's statement numbers. Every statement goes into at most one problem.
- "receipts": that topic's 3 statement numbers that best prove the headline, from different accounts where possible, preferring ones with a verbatim quote.

${blocks}

Output ONLY JSON, one entry per topic, "k" being the topic number: {"rows":[{"k":0,"headline":"...","problems":[{"title":"...","detail":"...","items":[0,3]}],"receipts":[0,5,9]}]}`;
}

/** Parse a batch answer: entry k is read against topic k's own statement count. A topic the model
 *  skipped or garbled is null and gets asked again next run, never guessed. */
export function parseRowsSummary(text: string, counts: number[]): (RowSummary | null)[] | null {
  const obj = parseObject(text);
  if (!obj || !Array.isArray(obj.rows)) return null;
  const out: (RowSummary | null)[] = counts.map(() => null);
  for (const r of obj.rows as unknown[]) {
    const k = Number((r as { k?: unknown })?.k);
    if (!Number.isInteger(k) || k < 0 || k >= counts.length || out[k]) continue;
    out[k] = parseRowSummary(JSON.stringify(r), counts[k]);
  }
  return out;
}

/** Tie insights that have no account yet to one, from their call's outside attendees. No model: a
 *  few reads and updates. Returns how many were tied. Runs every night, so an account resolved after
 *  the insight was placed (a new contact, a fixed ref pattern) reaches the board without a re-sort. */
export async function relinkInsightAccounts(supabase: SupabaseClient, workspaceId: string, internalIds: Set<string>): Promise<number> {
  const { data, error } = await supabase.from('insight_items').select('id, source_ref')
    .eq('workspace_id', workspaceId).eq('source', 'external').not('subtype', 'is', null).is('company_id', null).limit(2000);
  if (error) throw error;
  const rows = (data as { id: string; source_ref: string | null }[] | null) ?? [];
  if (!rows.length) return 0;
  const accounts = await resolveInsightAccounts(supabase, workspaceId, rows.map(r => r.source_ref).filter((r): r is string => !!r), internalIds);
  let n = 0;
  for (const r of rows) {
    const a = r.source_ref ? accounts.get(r.source_ref) : null;
    if (!a?.companyId) continue;
    const { error: e } = await supabase.from('insight_items').update({ company_id: a.companyId, contact_id: a.contactId })
      .eq('workspace_id', workspaceId).eq('id', r.id).is('company_id', null);
    if (!e) n++;
  }
  return n;
}
