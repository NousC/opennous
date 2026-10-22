import type { SupabaseClient } from '@supabase/supabase-js';
import { cosine, parseVector } from './aboutUsClaims.js';
import { getInternalEntityIds } from './teamMembers.js';

// The insight engine (GET-971): one way to turn what customers said into insights.
//
// Before it there were four groupings of the same sentences (the insight category, its kind, the
// board's subtype and tags, model-titled themes) and three status stores. Here an INSIGHT TYPE is a
// definition: what it counts, the field it groups on, the bar, and the teams it is for. Code builds
// the groups and counts them. The model writes nothing but a group's title, once it is over its bar.
//
// What it counts: claims about us (GET-969: feedback on our product, our pitch, the market) and,
// for objections and competitors, the claims on the accounts themselves. It leaves insight_items,
// themes and the board alone: /insights keeps reading those.

export type Audience = 'product' | 'cs' | 'gtm' | 'lead';
export const AUDIENCES: { key: Audience; label: string }[] = [
  { key: 'product', label: 'Product & Engineering' },
  { key: 'cs', label: 'Customer Success & Expansion' },
  { key: 'gtm', label: 'Go-to-market' },
  { key: 'lead', label: 'Founders & Leadership' },
];

export interface InsightTypeDef {
  key: string;
  label: string;
  /** The teams it is for; the first is its home team. */
  audiences: Audience[];
  /** Claims about us of these kinds (about_us_claims.kind). */
  aboutUs: string[];
  /** Claims on the account of this category (claims value.category), when it counts those too. */
  accountCategory?: 'objection' | 'competitor';
  /** How many separate accounts make it an insight. */
  minAccounts: number;
}

/** One bar for all, as GTM insights (GET-1001): a pattern heard from 5 accounts. */
export const INSIGHT_MIN_ACCOUNTS = 5;

// The board's ten kinds (insightBoard.ts), named and routed as the GTM insights page names them,
// plus praise: what lands is worth counting too.
export const INSIGHT_TYPES: InsightTypeDef[] = [
  { key: 'feature', label: 'Feature request', audiences: ['product', 'gtm'], aboutUs: ['feature'], minAccounts: INSIGHT_MIN_ACCOUNTS },
  { key: 'bug', label: 'Bug', audiences: ['product', 'cs'], aboutUs: ['bug'], minAccounts: INSIGHT_MIN_ACCOUNTS },
  { key: 'friction', label: 'Product friction', audiences: ['product', 'cs'], aboutUs: ['friction'], minAccounts: INSIGHT_MIN_ACCOUNTS },
  { key: 'setup', label: 'Setup blocker', audiences: ['cs', 'product'], aboutUs: ['setup'], minAccounts: INSIGHT_MIN_ACCOUNTS },
  { key: 'training', label: 'Adoption gap', audiences: ['cs'], aboutUs: ['training'], minAccounts: INSIGHT_MIN_ACCOUNTS },
  { key: 'objection', label: 'Objection', audiences: ['gtm'], aboutUs: ['objection'], accountCategory: 'objection', minAccounts: INSIGHT_MIN_ACCOUNTS },
  { key: 'pricing', label: 'Pricing', audiences: ['gtm', 'lead'], aboutUs: ['pricing'], minAccounts: INSIGHT_MIN_ACCOUNTS },
  { key: 'pitch', label: 'Pitch & messaging', audiences: ['gtm', 'lead'], aboutUs: ['pitch'], minAccounts: INSIGHT_MIN_ACCOUNTS },
  { key: 'praise', label: 'What lands', audiences: ['gtm', 'lead'], aboutUs: ['praise'], minAccounts: INSIGHT_MIN_ACCOUNTS },
  { key: 'partners', label: 'Competitor', audiences: ['lead', 'gtm'], aboutUs: ['partners'], accountCategory: 'competitor', minAccounts: INSIGHT_MIN_ACCOUNTS },
  { key: 'buyers', label: 'Buyer pattern', audiences: ['lead', 'gtm'], aboutUs: ['buyers'], minAccounts: INSIGHT_MIN_ACCOUNTS },
];
const TYPE_BY_KEY = new Map(INSIGHT_TYPES.map(t => [t.key, t]));
export const insightType = (key: string): InsightTypeDef | null => TYPE_BY_KEY.get(key) ?? null;
const TYPE_OF_KIND = new Map(INSIGHT_TYPES.flatMap(t => t.aboutUs.map(k => [k, t.key] as const)));

// ── One status per insight ───────────────────────────────────────────────────
export const PATTERN_STATUSES = ['new', 'seen', 'acting', 'done'] as const;
export type PatternStatus = (typeof PATTERN_STATUSES)[number];
export const isPatternStatus = (s: unknown): s is PatternStatus => (PATTERN_STATUSES as readonly string[]).includes(s as string);

// ── What gets counted ────────────────────────────────────────────────────────

export interface Member {
  /** 'about_us_claims' or 'claims', and the row's id. */
  table: 'about_us_claims' | 'claims';
  id: string;
  type: string;
  /** The fixed field it groups on: what was asked for, the competitor, the objection's label. */
  key: string | null;
  content: string;
  quote: string | null;
  companyId: string | null;
  contactId: string | null;
  speaker: string | null;
  sourceRef: string | null;
  sourceSystem: string | null;
  at: string | null;
  vec: number[] | null;
}

/** A fixed field as a grouping key: case, punctuation and a plural do not make two things. Pure. */
export function normalizeKey(s: unknown): string | null {
  const k = String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map(w => (w.length > 3 ? w.replace(/(?<!s)s$/, '') : w)).join(' ');
  return k || null;
}

/** Two members within a type are the same point at this similarity (by meaning, no shared key). */
export const GROUP_SIMILARITY = 0.8;
/** Two keyed groups are one when their centroids are this close ("Date filter" / "Filter by date"). */
export const KEY_MERGE_SIMILARITY = 0.88;

const centroid = (vecs: number[][]): number[] | null => {
  if (!vecs.length) return null;
  const out = new Array(vecs[0].length).fill(0);
  for (const v of vecs) for (let i = 0; i < v.length; i++) out[i] += v[i];
  return out.map(x => x / vecs.length);
};

export interface Group { type: string; topicKey: string; label: string | null; members: Member[] }

/**
 * Group one type's members. Pure.
 *  1. By the fixed field: every member with the same normalised key is one group.
 *  2. Keyed groups whose centroids are within KEY_MERGE_SIMILARITY are merged (the larger names it).
 *  3. A member with no key joins the nearest group at GROUP_SIMILARITY, else starts its own; oldest
 *     first, so a group's identity is its first member and stays put as new ones arrive.
 * The topic key is stable across rebuilds: `type|k:<key>` for a keyed group, `type|m:<first id>`.
 */
export function groupMembers(members: Member[], { similarity = GROUP_SIMILARITY, keyMerge = KEY_MERGE_SIMILARITY } = {}): Group[] {
  const byType = new Map<string, Member[]>();
  for (const m of members) { if (!byType.has(m.type)) byType.set(m.type, []); byType.get(m.type)!.push(m); }
  const out: Group[] = [];
  for (const [type, list] of byType) {
    const sorted = [...list].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')) || a.id.localeCompare(b.id));
    type G = { key: string | null; first: Member; members: Member[]; labels: Map<string, number> };
    const keyed = new Map<string, G>();
    const loose: Member[] = [];
    for (const m of sorted) {
      const k = normalizeKey(m.key);
      if (!k) { loose.push(m); continue; }
      if (!keyed.has(k)) keyed.set(k, { key: k, first: m, members: [], labels: new Map() });
      const g = keyed.get(k)!;
      g.members.push(m);
      const label = String(m.key).trim();
      g.labels.set(label, (g.labels.get(label) ?? 0) + 1);
    }
    // Merge keyed groups that mean the same thing, largest first so it keeps its name.
    const groups: G[] = [...keyed.values()].sort((a, b) => b.members.length - a.members.length || String(a.key).localeCompare(String(b.key)));
    // A group's direction is the sum of its vectors (cosine does not care about scale), kept as it
    // grows, so a merge never re-adds every member: the pairwise pass is O(groups² · dims), not cubic.
    const sums: (number[] | null)[] = groups.map(g => centroid(g.members.map(m => m.vec).filter((v): v is number[] => !!v)));
    for (let i = 0; i < groups.length; i++) {
      for (let j = groups.length - 1; j > i; j--) {
        const a = sums[i], b = sums[j];
        if (a && b && cosine(a, b) >= keyMerge) {
          const ni = groups[i].members.length, nj = groups[j].members.length;
          sums[i] = a.map((x, k) => (x * ni + b[k] * nj) / (ni + nj));
          groups[i].members.push(...groups[j].members);
          for (const [l, n] of groups[j].labels) groups[i].labels.set(l, (groups[i].labels.get(l) ?? 0) + n);
          groups.splice(j, 1); sums.splice(j, 1);
        }
      }
    }
    // Loose members: nearest group by meaning, else a group of their own.
    const cents = sums;
    for (const m of loose) {
      let best = -1, bestSim = similarity;
      if (m.vec) groups.forEach((g, i) => { const c = cents[i]; if (c) { const s = cosine(m.vec!, c); if (s >= bestSim) { bestSim = s; best = i; } } });
      if (best >= 0) { groups[best].members.push(m); continue; }
      groups.push({ key: null, first: m, members: [m], labels: new Map() });
      cents.push(m.vec);
    }
    for (const g of groups) {
      const label = [...g.labels.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
      out.push({ type, topicKey: g.key ? `${type}|k:${g.key}` : `${type}|m:${g.first.id}`, label, members: g.members });
    }
  }
  return out;
}

// ── Counting ─────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (iso: string | null) => (iso ? Date.parse(iso.slice(0, 10) + 'T00:00:00Z') : NaN);

export interface PatternCounts {
  accounts: number; people: number; mentions: number;
  firstHeard: string | null; lastHeard: string | null;
  /** Accounts per week, the last 12 weeks up to today, oldest first. */
  weeks: number[];
  /** Accounts in the last 30 days, and in the 30 before. */
  now: number; before: number; rising: boolean; atBar: boolean;
}

/** A group's numbers, counted from today. Accounts are named companies; a mention is a
 *  conversation (one call counted once). Rising is the GTM insights rule: +2 accounts and half
 *  again, the last 30 days against the 30 before. Pure. */
export function countPattern(members: Member[], minAccounts: number, today: string): PatternCounts {
  const accounts = new Set(members.map(m => m.companyId).filter(Boolean));
  const people = new Set(members.map(m => m.contactId ?? (m.speaker ? `${m.speaker.toLowerCase()}|${m.companyId}` : null)).filter(Boolean));
  const mentions = new Set(members.map(m => m.sourceRef ?? `${m.table}:${m.id}`));
  const days = members.map(m => m.at?.slice(0, 10)).filter((d): d is string => !!d).sort();
  const t = dayMs(today);
  const inWindow = (from: number, to: number) => new Set(members.filter(m => { const d = dayMs(m.at); return m.companyId && d > from && d <= to; }).map(m => m.companyId)).size;
  const now = inWindow(t - 30 * DAY, t), before = inWindow(t - 60 * DAY, t - 30 * DAY);
  const weeks = Array.from({ length: 12 }, (_, i) => {
    const end = t - (11 - i) * 7 * DAY;
    return inWindow(end - 7 * DAY, end);
  });
  return {
    accounts: accounts.size, people: people.size, mentions: mentions.size,
    firstHeard: days[0] ?? null, lastHeard: days[days.length - 1] ?? null,
    weeks, now, before, rising: now - before >= 2 && now > before * 1.5, atBar: accounts.size >= minAccounts,
  };
}

/** Titles are rewritten as a pattern grows: at its bar, then every 5 more accounts (as GET-1001).
 *  `title_account_count` is when one was last tried: a title not used (it named someone) is tried
 *  again only at the next step, so the same groups never take every title of every run. */
export const TITLE_STEP = 5;
export const titleStep = (accounts: number) => Math.floor(accounts / TITLE_STEP);
export function needsTitle(p: { title?: string | null; title_account_count?: number | null }, accounts: number, atBar: boolean): boolean {
  if (!atBar) return false;
  if (p.title_account_count == null) return true;
  return titleStep(accounts) > titleStep(p.title_account_count);
}

/** The prompt for one pattern's title: one sentence, from its own claims, inventing nothing. */
export function buildPatternTitlePrompt(type: InsightTypeDef, label: string | null, members: Member[], accounts: number): string {
  const lines = members.slice(0, 30).map((m, i) => `${i + 1}. ${m.content}${m.quote ? ` — "${m.quote.slice(0, 200)}"` : ''}`).join('\n');
  return `Across ${accounts} different customer accounts, these statements were grouped as one ${type.label.toLowerCase()}${label ? ` about "${label}"` : ''}:

${lines}

Write the insight's title: ONE plain sentence, at most 14 words, that says what these accounts have in common. Use only what the statements say; never add a cause, a number or a recommendation they do not contain. No customer or person names. Sentence case, no trailing period.

Output ONLY JSON: {"title": "..."}`;
}

export function parsePatternTitle(text: string): string | null {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const t = JSON.parse(m[0])?.title;
    const s = typeof t === 'string' ? t.replace(/\s+/g, ' ').trim().replace(/\.$/, '') : '';
    return s && s.length <= 160 ? s : null;
  } catch { return null; }
}

// ── Reading what gets counted ────────────────────────────────────────────────

async function pages<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/** Everything one workspace's insights are counted from, as members. Our own people never count. */
export async function loadMembers(supabase: SupabaseClient, workspaceId: string): Promise<Member[]> {
  const internal: Set<string> = await getInternalEntityIds(supabase, workspaceId).catch(() => new Set<string>());
  const about = await pages<any>((from, to) => supabase.from('about_us_claims')
    .select('id, kind, what, content, quote, quote_private, company_id, contact_id, speaker, source_ref, source_system, occurred_at, created_at, embedding')
    .eq('workspace_id', workspaceId).is('retired_at', null).order('id').range(from, to));
  const members: Member[] = [];
  for (const r of about) {
    const type = TYPE_OF_KIND.get(r.kind);
    if (!type || (r.contact_id && internal.has(r.contact_id)) || (r.company_id && internal.has(r.company_id))) continue;
    members.push({
      table: 'about_us_claims', id: r.id, type, key: r.what ?? null, content: r.content, quote: r.quote_private ? null : r.quote ?? null,
      companyId: r.company_id ?? null, contactId: r.contact_id ?? null, speaker: r.speaker ?? null,
      sourceRef: r.source_ref ?? null, sourceSystem: r.source_system ?? null, at: r.occurred_at ?? r.created_at ?? null, vec: parseVector(r.embedding),
    });
  }
  // Objections and competitors on the accounts themselves: live claims only.
  for (const t of INSIGHT_TYPES.filter(x => x.accountCategory)) {
    const rows = await pages<any>((from, to) => supabase.from('claims')
      .select('id, entity_id, value, valid_from, embedding')
      .eq('workspace_id', workspaceId).eq('value->>category', t.accountCategory!).is('invalid_at', null)
      .gte('property', 'note.').lt('property', 'note/').order('id').range(from, to));
    if (!rows.length) continue;
    const ids = [...new Set(rows.map(r => r.entity_id))];
    const company = new Map<string, string | null>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await supabase.from('entity_list_rows').select('entity_id, kind, company_id')
        .eq('workspace_id', workspaceId).in('entity_id', ids.slice(i, i + 200));
      if (error) throw error;
      for (const e of data ?? []) company.set(e.entity_id, e.kind === 'account' ? e.entity_id : e.company_id ?? null);
    }
    for (const r of rows) {
      const v = r.value ?? {};
      if (internal.has(r.entity_id)) continue;
      // A competitor named only in passing is not one we compete with.
      if (t.accountCategory === 'competitor' && v.metadata?.stance === 'mentioned') continue;
      const person = company.get(r.entity_id) === r.entity_id ? (v.metadata?.voiced_by_contact_id ?? null) : r.entity_id;
      members.push({
        table: 'claims', id: r.id, type: t.key,
        // A competitor groups on its name. An objection groups by meaning; with no vector yet (the
        // embeddings worker fills it in), on its label.
        key: t.accountCategory === 'competitor' ? (v.metadata?.entity ?? v.label ?? null) : r.embedding ? null : (v.label ?? null),
        content: String(v.content ?? ''), quote: null,
        companyId: company.get(r.entity_id) ?? null, contactId: person, speaker: null,
        sourceRef: v.metadata?.source_activity_id ? `activity:${v.metadata.source_activity_id}` : null,
        sourceSystem: v.metadata?.extraction_source ?? null, at: r.valid_from ?? null, vec: parseVector(r.embedding),
      });
    }
  }
  return members.filter(m => m.content);
}

// ── Rebuilding a workspace's insights ────────────────────────────────────────

export interface RebuildOptions {
  /** Today, as the day every window counts back from. */
  today?: string;
  /** Writes a title: prompt in, model text out. No model, no titles (the label stands in). */
  ask?: ((prompt: string) => Promise<string>) | null;
  /** Fires an event (services/events.mjs emitEvent). */
  emit?: ((e: { workspaceId: string; type: string; dedupeKey: string; data: Record<string, unknown> }) => Promise<unknown>) | null;
  /** At most this many titles written per run: the rest wait for the next one. */
  maxTitles?: number;
}

export interface RebuildResult { status: 'rebuilt' | 'not_set_up'; members: number; patterns: number; atBar: number; titled: number; emerged: number; rising: number }

/** Rising starts when an insight over its bar is rising and was not, as an insight, before: one
 *  that crossed its bar while already rising starts rising then. */
const startsRising = (old: any, c: PatternCounts) => c.atBar && c.rising && (!old?.rising_at || !(old?.rising && old?.at_bar));
const MISSING = (e: any) => e?.code === '42P01' || /does not exist/i.test(String(e?.message ?? ''));
const weekOf = (iso: string) => { const d = new Date(iso.slice(0, 10) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return isoDay(d.getTime()); };

/**
 * Carry an insight's identity across a regrouping. A group takes the topic key of the insight that
 * most of its members belonged to last time (a majority of the group's, or of the old insight's),
 * so a rename, a merge or an older member arriving late does not mint a new insight, lose its
 * status or fire insight.emerged again. Each old insight goes to one group at most. Pure.
 */
export function keepIdentity(groups: Group[], existing: { id: string; topic_key: string }[], previous: { pattern_id: string; source_table: string; source_id: string }[]): Group[] {
  const was = new Map(previous.map(p => [`${p.source_table}:${p.source_id}`, p.pattern_id]));
  const oldSize = new Map<string, number>();
  for (const p of previous) oldSize.set(p.pattern_id, (oldSize.get(p.pattern_id) ?? 0) + 1);
  const keyOf = new Map(existing.map(p => [p.id, p.topic_key]));
  const candidates: { gi: number; pid: string; n: number }[] = [];
  groups.forEach((g, gi) => {
    const votes = new Map<string, number>();
    for (const m of g.members) { const pid = was.get(`${m.table}:${m.id}`); if (pid) votes.set(pid, (votes.get(pid) ?? 0) + 1); }
    for (const [pid, n] of votes) if (keyOf.has(pid) && (n * 2 > g.members.length || n * 2 > (oldSize.get(pid) ?? 0))) candidates.push({ gi, pid, n });
  });
  candidates.sort((a, b) => b.n - a.n || a.gi - b.gi);
  const keyFor = new Map<number, string>(), takenOld = new Set<string>();
  for (const c of candidates) {
    if (keyFor.has(c.gi) || takenOld.has(c.pid)) continue;
    keyFor.set(c.gi, keyOf.get(c.pid)!); takenOld.add(c.pid);
  }
  const used = new Set(keyFor.values());
  return groups.map((g, gi) => {
    if (keyFor.has(gi)) return { ...g, topicKey: keyFor.get(gi)! };
    // A fresh key that an old insight's group already carries: made unique by its first member.
    const key = used.has(g.topicKey) ? `${g.topicKey}#${g.members[0]?.id ?? gi}` : g.topicKey;
    used.add(key);
    return { ...g, topicKey: key };
  });
}

/** Whether a title names one of these people or companies (a whole-word match, 3+ letters). Pure. */
export function namesSomeone(title: string, names: string[]): boolean {
  const t = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return names.some(n => {
    const parts = String(n ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w.length >= 3);
    return parts.some(w => t.includes(` ${w} `));
  });
}

async function namesOf(supabase: SupabaseClient, workspaceId: string, members: Member[]): Promise<string[]> {
  const ids = [...new Set(members.flatMap(m => [m.companyId, m.contactId]).filter((x): x is string => !!x))].slice(0, 200);
  const speakers = members.map(m => m.speaker).filter((x): x is string => !!x);
  if (!ids.length) return speakers;
  const { data } = await supabase.from('entity_list_rows').select('name').eq('workspace_id', workspaceId).in('entity_id', ids);
  return [...speakers, ...((data ?? []) as any[]).map(r => r.name).filter(Boolean)];
}

/** What an insight's event carries: what it is, who it is for, and its numbers. No quotes, no
 *  customer names: a webhook is a shared destination and an insight is workspace-wide. */
export function patternEventData(p: { id: string; type: string; title: string | null; label: string | null }, c: PatternCounts) {
  const t = insightType(p.type);
  return {
    insight: {
      id: p.id, type: p.type, type_label: t?.label ?? p.type, audiences: t?.audiences ?? [],
      title: p.title ?? p.label ?? null, topic: p.label ?? null,
      accounts: c.accounts, people: c.people, mentions: c.mentions,
      first_heard: c.firstHeard, last_heard: c.lastHeard, accounts_last_30_days: c.now, accounts_prior_30_days: c.before,
    },
  };
}

/**
 * Rebuild one workspace's insights from what is counted. Groups and numbers come from code;
 * a status a person set is kept, as is an insight whose members have gone (it shows 0 accounts).
 * Fires insight.emerged the first time an insight crosses its bar, and insight.rising when it
 * starts rising (once a week at most).
 */
export async function rebuildInsightPatterns(supabase: SupabaseClient, workspaceId: string, opts: RebuildOptions = {}): Promise<RebuildResult> {
  const today = opts.today ?? isoDay(Date.now());
  const result: RebuildResult = { status: 'rebuilt', members: 0, patterns: 0, atBar: 0, titled: 0, emerged: 0, rising: 0 };
  // Every page of what is there: a partial read would take the rest for new insights (their titles
  // wiped, their events fired again).
  let existing: any[], previous: any[], members: Member[];
  try {
    existing = await pages<any>((from, to) => supabase.from('insight_patterns')
      .select('id, topic_key, title, title_account_count, emerged_at, rising, rising_at, at_bar')
      .eq('workspace_id', workspaceId).order('id').range(from, to));
    previous = await pages<any>((from, to) => supabase.from('insight_pattern_members')
      .select('pattern_id, source_table, source_id').eq('workspace_id', workspaceId).order('pattern_id').order('source_id').range(from, to));
    members = await loadMembers(supabase, workspaceId);
  } catch (e) { if (MISSING(e)) return { ...result, status: 'not_set_up' }; throw e; }
  result.members = members.length;
  const groups = keepIdentity(groupMembers(members), existing, previous);
  const before = new Map(existing.map((p: any) => [p.topic_key, p]));
  const now = new Date().toISOString();
  let titlesLeft = opts.maxTitles ?? 20;

  const rows: Record<string, unknown>[] = [];
  const pending: { g: Group; c: PatternCounts; old: any; title: string | null; titleCount: number | null }[] = [];
  for (const g of groups) {
    const t = insightType(g.type);
    if (!t) continue;
    const c = countPattern(g.members, t.minAccounts, today);
    const old = before.get(g.topicKey) ?? null;
    let title: string | null = old?.title ?? null, titleCount: number | null = old?.title_account_count ?? null;
    if (opts.ask && titlesLeft > 0 && needsTitle({ title, title_account_count: titleCount }, c.accounts, c.atBar)) {
      titlesLeft--;
      const answer = await opts.ask(buildPatternTitlePrompt(t, g.label, g.members, c.accounts)).catch(() => '');
      const written = parsePatternTitle(answer);
      // A title goes out in events and to every member: one naming a customer is not used. It
      // counts as tried all the same; a read that failed (no answer) is tried next run.
      if (written && !namesSomeone(written, await namesOf(supabase, workspaceId, g.members))) { title = written; titleCount = c.accounts; result.titled++; }
      else if (answer) titleCount = c.accounts;
    }
    pending.push({ g, c, old, title, titleCount });
    rows.push({
      workspace_id: workspaceId, topic_key: g.topicKey, type: g.type, label: g.label,
      title, title_account_count: titleCount,
      account_count: c.accounts, people_count: c.people, mention_count: c.mentions,
      first_heard_at: c.firstHeard, last_heard_at: c.lastHeard, weeks: c.weeks,
      recent_accounts: c.now, prior_accounts: c.before, rising: c.rising, at_bar: c.atBar,
      // Marked after its event is sent (below): a run that fails before then sends it next time.
      emerged_at: old?.emerged_at ?? null,
      rising_at: old?.rising_at ?? null,
      updated_at: now,
    });
  }
  // Insights whose members have all gone stay, with nothing behind them, so their status holds.
  const seen = new Set(groups.map(g => g.topicKey));
  const gone = existing.filter((p: any) => !seen.has(p.topic_key)).map((p: any) => p.id);

  const ids = new Map<string, string>();
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await supabase.from('insight_patterns')
      .upsert(rows.slice(i, i + 500), { onConflict: 'workspace_id,topic_key' }).select('id, topic_key');
    if (error) throw error;
    for (const r of data ?? []) ids.set(r.topic_key, r.id);
  }
  for (let i = 0; i < gone.length; i += 200) {
    const { error } = await supabase.from('insight_patterns')
      .update({ account_count: 0, people_count: 0, mention_count: 0, recent_accounts: 0, prior_accounts: 0, weeks: Array(12).fill(0), rising: false, at_bar: false, updated_at: now })
      .in('id', gone.slice(i, i + 200));
    if (error) throw error;
  }
  // Members: replaced whole, so a regrouping never leaves a row in two insights.
  const { error: delErr } = await supabase.from('insight_pattern_members').delete().eq('workspace_id', workspaceId);
  if (delErr) throw delErr;
  const memberRows = pending.flatMap(({ g }) => g.members.map(m => ({
    workspace_id: workspaceId, pattern_id: ids.get(g.topicKey), source_table: m.table, source_id: m.id,
    company_id: m.companyId, contact_id: m.contactId, occurred_at: m.at,
  }))).filter(r => r.pattern_id);
  for (let i = 0; i < memberRows.length; i += 1000) {
    const { error } = await supabase.from('insight_pattern_members').insert(memberRows.slice(i, i + 1000));
    if (error) throw error;
  }
  result.patterns = rows.length;

  for (const { g, c, old, title } of pending) {
    if (c.atBar) result.atBar++;
    const id = ids.get(g.topicKey);
    if (!id) continue;
    const p = { id, type: g.type, title, label: g.label };
    const mark: Record<string, string> = {};
    if (c.atBar && !old?.emerged_at) {
      await opts.emit?.({ workspaceId, type: 'insight.emerged', dedupeKey: id, data: patternEventData(p, c) });
      mark.emerged_at = now; result.emerged++;
    }
    if (startsRising(old, c)) {
      await opts.emit?.({ workspaceId, type: 'insight.rising', dedupeKey: `${id}:${weekOf(today)}`, data: patternEventData(p, c) });
      mark.rising_at = now; result.rising++;
    }
    if (Object.keys(mark).length) {
      const { error } = await supabase.from('insight_patterns').update(mark).eq('id', id);
      if (error) throw error;
    }
  }
  return result;
}

// ── Reading insights ─────────────────────────────────────────────────────────

export interface PatternView {
  id: string; type: string; type_label: string; audiences: Audience[];
  title: string | null; topic: string | null; status: PatternStatus;
  accounts: number; people: number; mentions: number;
  first_heard: string | null; last_heard: string | null; weeks: number[];
  accounts_last_30_days: number; accounts_prior_30_days: number; rising: boolean; emerged_at: string | null;
}

export const patternView = (p: any): PatternView => {
  const t = insightType(p.type);
  return {
    id: p.id, type: p.type, type_label: t?.label ?? p.type, audiences: t?.audiences ?? [],
    title: p.title ?? null, topic: p.label ?? null, status: isPatternStatus(p.status) ? p.status : 'new',
    accounts: p.account_count ?? 0, people: p.people_count ?? 0, mentions: p.mention_count ?? 0,
    first_heard: p.first_heard_at ?? null, last_heard: p.last_heard_at ?? null, weeks: p.weeks ?? [],
    accounts_last_30_days: p.recent_accounts ?? 0, accounts_prior_30_days: p.prior_accounts ?? 0,
    rising: !!p.rising, emerged_at: p.emerged_at ?? null,
  };
};

/** A workspace's insights over their bar, most accounts first. Filter by audience, type or status. */
export async function listInsightPatterns(supabase: SupabaseClient, workspaceId: string, f: { audience?: string | null; type?: string | null; status?: string | null; limit?: number } = {}): Promise<PatternView[] | null> {
  let q = supabase.from('insight_patterns').select('*').eq('workspace_id', workspaceId).eq('at_bar', true);
  if (f.type) q = q.eq('type', f.type);
  if (f.audience) q = q.in('type', INSIGHT_TYPES.filter(t => t.audiences.includes(f.audience as Audience)).map(t => t.key));
  if (f.status && isPatternStatus(f.status)) q = q.eq('status', f.status);
  const { data, error } = await q.order('account_count', { ascending: false }).order('last_heard_at', { ascending: false }).limit(Math.min(Math.max(f.limit ?? 100, 1), 500));
  if (error) { if (MISSING(error)) return null; throw error; }
  return (data ?? []).map(patternView);
}

/** One insight with what it rests on: its claims, newest first, each with its account and source. */
export async function getInsightPattern(supabase: SupabaseClient, workspaceId: string, id: string): Promise<(PatternView & { evidence: any[] }) | null> {
  const { data: p, error } = await supabase.from('insight_patterns').select('*').eq('workspace_id', workspaceId).eq('id', id).maybeSingle();
  if (error) { if (MISSING(error)) return null; throw error; }
  if (!p) return null;
  const { data: ms, error: mErr } = await supabase.from('insight_pattern_members').select('source_table, source_id, company_id, contact_id, occurred_at')
    .eq('workspace_id', workspaceId).eq('pattern_id', id).order('occurred_at', { ascending: false }).limit(200);
  if (mErr) throw mErr;
  const aboutIds = (ms ?? []).filter((m: any) => m.source_table === 'about_us_claims').map((m: any) => m.source_id);
  const claimIds = (ms ?? []).filter((m: any) => m.source_table === 'claims').map((m: any) => m.source_id);
  const [{ data: about }, { data: claims }] = await Promise.all([
    aboutIds.length ? supabase.from('about_us_claims').select('id, content, quote, quote_private, speaker, source_ref, source_system, what, use_case, product_area, asked_by, job').in('id', aboutIds) : Promise.resolve({ data: [] as any[] }),
    claimIds.length ? supabase.from('claims').select('id, value').in('id', claimIds) : Promise.resolve({ data: [] as any[] }),
  ]);
  // A quote out of a private message never leaves it (GET-985): the fact shows, the words do not.
  const byId = new Map<string, any>([...(about ?? []).map((a: any) => { const { quote_private, ...rest } = a; return [a.id, { ...rest, quote: quote_private ? null : a.quote }] as const; }), ...(claims ?? []).map((c: any) => [c.id, { id: c.id, content: c.value?.content ?? null, source_system: c.value?.metadata?.extraction_source ?? null }] as const)]);
  const evidence = (ms ?? []).map((m: any) => ({ ...(byId.get(m.source_id) ?? { id: m.source_id }), from: m.source_table === 'claims' ? 'account_claim' : 'claim_about_us', account_id: m.company_id, person_id: m.contact_id, date: m.occurred_at }));
  return { ...patternView(p), evidence };
}

/** Set an insight's one status. Returns false when there is no such insight. */
export async function setInsightPatternStatus(supabase: SupabaseClient, workspaceId: string, id: string, status: PatternStatus, by: string | null = null): Promise<boolean> {
  const { data, error } = await supabase.from('insight_patterns')
    .update({ status, status_changed_at: new Date().toISOString(), status_changed_by: by }).eq('workspace_id', workspaceId).eq('id', id).select('id');
  if (error) throw error;
  return (data ?? []).length > 0;
}
