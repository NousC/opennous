import type { SupabaseClient } from '@supabase/supabase-js';

// Market entities (GET-1049): one canonical name per competitor, tool or product named in customer
// conversations.
//
// A competitor or tool is free text on a claim (value.metadata.entity / .tool), so "HubSpot MCP",
// "HubSpot's MCP" and "Hubspot" were three things to the insight engine and to the battlecards file.
// This module resolves a name to one row in market_entities (aliases in market_entity_aliases) and the
// claim keeps its free text plus `metadata.market_entity_id`. The claim's own `entity_id` is the
// person or company it is about, so the market entity gets its own key rather than `metadata.entity_id`.
//
// The matcher is ported from Hindsight's entity_resolver.py (MIT, github.com/vectorize-io/hindsight)
// and has no model in it: trigram Jaccard as pg_trgm computes it, a word gate, a number rule and a
// parent/child rule. What it cannot settle (the 'ask' band) is created as its own entity with a
// pending proposal (market_entities.proposed_same_as), for a model or a person to decide later.

export type MarketEntityKind = 'competitor' | 'tool' | 'product';

// ── The pure matcher ─────────────────────────────────────────────────────────

/**
 * A name as a key: NFKD, accents off, lowercase, a possessive "'s" dropped, every run of punctuation,
 * hyphens and underscores a space, spaces collapsed. "HubSpot's" → "hubspot", "GPT-4" → "gpt 4". One
 * addition to Hindsight's: a product's web suffix is dropped ("Lumen.io" → "lumen"), since buyers say a
 * vendor's name with and without it and the two are never different things. Pure.
 */
export function normalizeEntityName(name: unknown): string {
  return String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/\.(?:io|com|ai|co|app|so|dev)\b/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** The words of a normalised name: runs of letters and digits. Pure. */
export const entityWords = (normalized: string): string[] => normalized.match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Trigrams the way pg_trgm makes them: each word padded with two spaces in front and one behind
 * ("  w "), every three-character window of that. Pure.
 */
export function trigrams(normalized: string): Set<string> {
  const out = new Set<string>();
  for (const w of entityWords(normalized)) {
    const p = `  ${w} `;
    for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  }
  return out;
}

/** Jaccard of two trigram sets, rounded to 6 decimals so 0.5 is 0.5 on every machine. Pure. */
export function trigramSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return round6(inter / (a.size + b.size - inter));
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * Ratcliff/Obershelp similarity, 2·M / (|a|+|b|) where M is matched by recursively taking the longest
 * common block and matching what lies left and right of it. It is what Python's
 * difflib.SequenceMatcher(None, a, b).ratio() returns (its auto-junk only starts at 200 characters,
 * well past any word here), so the word gate behaves as Hindsight's does. Pure.
 */
export function sequenceRatio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const matched = (a0: number, a1: number, b0: number, b1: number): number => {
    let best = 0, bi = 0, bj = 0;
    for (let i = a0; i < a1; i++) {
      for (let j = b0; j < b1; j++) {
        let k = 0;
        while (i + k < a1 && j + k < b1 && a[i + k] === b[j + k]) k++;
        if (k > best) { best = k; bi = i; bj = j; }
      }
    }
    if (!best) return 0;
    return best + matched(a0, bi, b0, bj) + matched(bi + best, a1, bj + best, b1);
  };
  return round6((2 * matched(0, a.length, 0, b.length)) / (a.length + b.length));
}

/** Two words are the same word: equal, one a prefix of the other, or a ratio of at least 0.6. */
export const WORD_RATIO = 0.6;
const wordsMatch = (x: string, y: string) => x === y || x.startsWith(y) || y.startsWith(x) || sequenceRatio(x, y) >= WORD_RATIO;

/**
 * The word gate: every word of the name with fewer words matches some word of the other. A name of
 * one word passes ("HubSpot" vs "Hub Spot" is for the trigrams to decide). Pure.
 */
export function wordGate(a: string[], b: string[]): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length <= 1) return true;
  return short.every(w => long.some(l => wordsMatch(w, l)));
}

/**
 * The number rule: when each name has a number the other lacks they are different things
 * ("Python 3.1" vs "Python 3.10", "Room 101" vs "Room 102"). One set inside the other is fine
 * ("Q3" vs "Q3 2024"). Pure.
 */
export function numbersCompatible(a: string, b: string): boolean {
  const na = new Set(a.match(/\d+/g) ?? []), nb = new Set(b.match(/\d+/g) ?? []);
  const aOnly = [...na].some(n => !nb.has(n)), bOnly = [...nb].some(n => !na.has(n));
  return !(aOnly && bOnly);
}

/** One name's words are a strict superset of the other's: "HubSpot MCP" over "HubSpot". Pure. */
export function isParentChild(a: string[], b: string[]): boolean {
  const sa = new Set(a), sb = new Set(b);
  if (sa.size === sb.size) return false;
  const [small, big] = sa.size < sb.size ? [sa, sb] : [sb, sa];
  return small.size > 0 && [...small].every(w => big.has(w));
}

/** At or above: the same thing, when the gates pass. */
export const SAME_SIMILARITY = 0.5;
/** At or above (and under SAME_SIMILARITY): too close to call, so it is asked. */
export const ASK_SIMILARITY = 0.3;

export type PairVerdict = 'same' | 'ask' | 'new';
export interface PairResult { verdict: PairVerdict; score: number; reason: string }

/**
 * Two normalised names, compared. Pure.
 *  - same key, or identical trigram sets → same
 *  - each has a number the other lacks → new
 *  - one's words a strict superset of the other's (a product line, a sub-product) → ask, whatever
 *    the score: "Gong" and "Gong Engage" are related and may or may not be one thing to count
 *  - Jaccard ≥ 0.5 and the word gate → same; ≥ 0.5 without the gate → ask
 *  - 0.3 ≤ Jaccard < 0.5 → ask, except two one-word names → new. Deviation from Hindsight: short
 *    brand names share trigrams by accident ("Clay"/"Clari" 0.375, "Notion"/"Motion" 0.4), and a
 *    one-word misspelling of a brand lands at 0.5 or above anyway ("Hubspt"/"HubSpot" 0.5).
 *  - below 0.3 → new
 */
export function comparePair(a: string, b: string): PairResult {
  if (a === b) return { verdict: 'same', score: 1, reason: 'exact' };
  const ta = trigrams(a), tb = trigrams(b);
  const score = trigramSimilarity(ta, tb);
  if (ta.size === tb.size && [...ta].every(t => tb.has(t))) return { verdict: 'same', score: 1, reason: 'trigrams_identical' };
  if (!numbersCompatible(a, b)) return { verdict: 'new', score, reason: 'numbers_differ' };
  const wa = entityWords(a), wb = entityWords(b);
  if (isParentChild(wa, wb)) return { verdict: 'ask', score, reason: 'parent_child' };
  if (score >= SAME_SIMILARITY) {
    return wordGate(wa, wb) ? { verdict: 'same', score, reason: 'similar' } : { verdict: 'ask', score, reason: 'word_gate' };
  }
  if (score >= ASK_SIMILARITY) {
    if (wa.length <= 1 && wb.length <= 1) return { verdict: 'new', score, reason: 'short_names_differ' };
    return { verdict: 'ask', score, reason: 'borderline' };
  }
  return { verdict: 'new', score, reason: 'different' };
}

export interface EntityCandidate { id: string; name: string; aliases?: string[] }
export type Decision =
  | { action: 'same'; entityId: string; score: number; reason: string }
  | { action: 'ask'; entityId: string; score: number; reason: string }
  | { action: 'new'; score: number; reason: string };

/**
 * Which known entity a new name is, if any. Pure. An exact alias (or canonical) hit always wins; else
 * the best 'same' by score, else the best 'ask', else 'new'. Each candidate is scored on its canonical
 * name and every alias, best of them.
 */
export function decideEntity(newName: string, candidates: EntityCandidate[]): Decision {
  const key = normalizeEntityName(newName);
  let same: Decision | null = null, ask: Decision | null = null, bestNew = 0;
  for (const c of candidates) {
    const names = [c.name, ...(c.aliases ?? [])].map(normalizeEntityName).filter(Boolean);
    if (names.includes(key)) return { action: 'same', entityId: c.id, score: 1, reason: 'alias' };
    for (const n of names) {
      const r = comparePair(key, n);
      if (r.verdict === 'same' && (!same || r.score > same.score)) same = { action: 'same', entityId: c.id, score: r.score, reason: r.reason };
      else if (r.verdict === 'ask' && (!ask || r.score > ask.score)) ask = { action: 'ask', entityId: c.id, score: r.score, reason: r.reason };
      else if (r.verdict === 'new') bestNew = Math.max(bestNew, r.score);
    }
  }
  return same ?? ask ?? { action: 'new', score: bestNew, reason: 'no_match' };
}

/** Which kind of market entity a claim category names, and the metadata field it is in. Pure. */
export function marketEntityFieldFor(category: string): { kind: MarketEntityKind; field: string } | null {
  if (category === 'competitor') return { kind: 'competitor', field: 'entity' };
  if (category === 'tech_stack') return { kind: 'tool', field: 'tool' };
  return null;
}

// ── Reading and writing ──────────────────────────────────────────────────────

/** The tables are not there yet: the migration has not been applied. Everything here then no-ops. */
export const marketEntitiesMissing = (e: any) => ['42P01', 'PGRST205'].includes(e?.code)
  || /market_entit(y|ies)/.test(String(e?.message ?? '')) && /does not exist|schema cache|could not find/i.test(String(e?.message ?? ''));

/** How many known entities of a kind the matcher compares against: a workspace names hundreds, not more. */
const CANDIDATE_LIMIT = 5000;

export interface ResolvedEntity { entityId: string; canonicalName: string; action: 'alias' | 'same' | 'ask' | 'new' }

/** Follow merged_into_id to the surviving entity (at most a few hops; a cycle stops). */
type Counted = { id: string; canonical_name: string; mention_count: number; first_seen?: string | null; last_seen?: string | null };
async function survivor(supabase: SupabaseClient, workspaceId: string, id: string): Promise<Counted | null> {
  let cur = id;
  for (let hop = 0; hop < 5; hop++) {
    const { data, error } = await supabase.from('market_entities').select('id, canonical_name, mention_count, first_seen, last_seen, merged_into_id')
      .eq('workspace_id', workspaceId).eq('id', cur).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (!data.merged_into_id) return data;
    cur = data.merged_into_id;
  }
  return null;
}

async function bump(supabase: SupabaseClient, workspaceId: string, e: Counted, at: string) {
  // Read-modify-write: two writers at the same moment can lose one count. The count is a hint for
  // display and ordering, not a number anything bills or gates on; an RPC is not worth it yet.
  // first/last seen only widen, so a backfill reading old claims never moves last_seen back.
  const patch: Record<string, unknown> = { mention_count: (e.mention_count ?? 0) + 1, updated_at: new Date().toISOString() };
  if (!e.last_seen || at > e.last_seen) patch.last_seen = at;
  if (!e.first_seen || at < e.first_seen) patch.first_seen = at;
  const { error } = await supabase.from('market_entities').update(patch)
    .eq('workspace_id', workspaceId).eq('id', e.id);
  if (error) throw error;
}

async function addAlias(supabase: SupabaseClient, workspaceId: string, kind: MarketEntityKind, entityId: string, alias: string, key: string, source: 'auto' | 'llm' | 'user') {
  const { error } = await supabase.from('market_entity_aliases').insert({ workspace_id: workspaceId, kind, entity_id: entityId, alias, normalized_alias: key, source });
  if (error && error.code !== '23505') throw error;   // someone filed the same spelling first: fine
}

async function aliasHit(supabase: SupabaseClient, workspaceId: string, kind: MarketEntityKind, key: string): Promise<string | null> {
  const { data, error } = await supabase.from('market_entity_aliases').select('entity_id')
    .eq('workspace_id', workspaceId).eq('kind', kind).eq('normalized_alias', key).limit(1);
  if (error) throw error;
  return data?.[0]?.entity_id ?? null;
}

/** The live entities of a kind with their aliases, as matcher candidates. */
export async function loadEntityCandidates(supabase: SupabaseClient, workspaceId: string, kind: MarketEntityKind): Promise<EntityCandidate[]> {
  const { data: ents, error } = await supabase.from('market_entities').select('id, canonical_name')
    .eq('workspace_id', workspaceId).eq('kind', kind).is('merged_into_id', null).limit(CANDIDATE_LIMIT);
  if (error) throw error;
  const { data: aliases, error: aErr } = await supabase.from('market_entity_aliases').select('entity_id, alias')
    .eq('workspace_id', workspaceId).eq('kind', kind).limit(CANDIDATE_LIMIT * 4);
  if (aErr) throw aErr;
  const byId = new Map<string, string[]>();
  for (const a of aliases ?? []) { if (!byId.has(a.entity_id)) byId.set(a.entity_id, []); byId.get(a.entity_id)!.push(a.alias); }
  return (ents ?? []).map(e => ({ id: e.id, name: e.canonical_name, aliases: byId.get(e.id) ?? [] }));
}

/**
 * Resolve one name to its market entity, creating it when it is new, and count the mention.
 *  - an alias hit: that entity (followed through merges), counted
 *  - 'same': that entity, the spelling added as an 'auto' alias, counted
 *  - 'ask': a new entity with proposed_same_as pointing at the candidate (the decision is a follow-up)
 *  - 'new': a new entity
 * Throws on a database error; callers that must not fail use resolveClaimMarketEntity.
 */
export async function resolveMarketEntity(
  supabase: SupabaseClient, workspaceId: string, kind: MarketEntityKind, name: string, { seenAt }: { seenAt?: string } = {},
): Promise<ResolvedEntity | null> {
  const alias = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const key = normalizeEntityName(alias);
  if (!key) return null;
  const at = seenAt ?? new Date().toISOString();

  const hit = await aliasHit(supabase, workspaceId, kind, key);
  if (hit) {
    const e = await survivor(supabase, workspaceId, hit);
    if (e) { await bump(supabase, workspaceId, e, at); return { entityId: e.id, canonicalName: e.canonical_name, action: 'alias' }; }
  }

  const d = decideEntity(alias, await loadEntityCandidates(supabase, workspaceId, kind));
  if (d.action === 'same') {
    const e = await survivor(supabase, workspaceId, d.entityId);
    if (e) {
      await addAlias(supabase, workspaceId, kind, e.id, alias, key, 'auto');
      await bump(supabase, workspaceId, e, at);
      return { entityId: e.id, canonicalName: e.canonical_name, action: 'same' };
    }
  }
  const { data: created, error } = await supabase.from('market_entities').insert({
    workspace_id: workspaceId, kind, canonical_name: alias, normalized_key: key, mention_count: 1, first_seen: at, last_seen: at,
    ...(d.action === 'ask' ? { proposed_same_as: d.entityId, proposed_score: d.score, proposed_reason: d.reason } : {}),
  }).select('id, canonical_name').single();
  if (error) {
    // The same key created a moment ago by another writer: it is that one.
    if (error.code === '23505') {
      const { data: row } = await supabase.from('market_entities').select('id, canonical_name, mention_count, first_seen, last_seen')
        .eq('workspace_id', workspaceId).eq('kind', kind).eq('normalized_key', key).maybeSingle();
      if (row) { await bump(supabase, workspaceId, row, at); return { entityId: row.id, canonicalName: row.canonical_name, action: 'alias' }; }
    }
    throw error;
  }
  await addAlias(supabase, workspaceId, kind, created.id, alias, key, 'auto');
  return { entityId: created.id, canonicalName: created.canonical_name, action: d.action === 'ask' ? 'ask' : 'new' };
}

/**
 * The claim-write seam (saveNote with resolveMarketEntity): for a competitor or tech_stack claim,
 * resolve its name and return the metadata to add ({ market_entity_id }). Never throws: with the
 * tables missing (migration not applied) or any database error, the claim is saved exactly as
 * before, with no id.
 */
export async function resolveClaimMarketEntity(
  supabase: SupabaseClient, workspaceId: string, category: string, metadata: Record<string, unknown>, { seenAt }: { seenAt?: string } = {},
): Promise<{ market_entity_id: string } | null> {
  const f = marketEntityFieldFor(category);
  const name = f ? metadata?.[f.field] : null;
  if (!f || typeof name !== 'string' || !name.trim() || metadata.market_entity_id) return null;
  try {
    const r = await resolveMarketEntity(supabase, workspaceId, f.kind, name, { seenAt });
    return r ? { market_entity_id: r.entityId } : null;
  } catch (e) {
    if (!marketEntitiesMissing(e)) console.warn('[MARKET_ENTITIES] resolve failed:', (e as Error)?.message ?? e);
    return null;
  }
}

/**
 * The canonical name of each market entity id (followed through merges), for counting by entity.
 * Empty on missing tables or any error: callers fall back to the claim's own text.
 */
export async function canonicalEntityNames(supabase: SupabaseClient, workspaceId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return out;
  try {
    const rows = new Map<string, { canonical_name: string; merged_into_id: string | null }>();
    let todo = want;
    for (let hop = 0; hop < 5 && todo.length; hop++) {
      const next: string[] = [];
      for (let i = 0; i < todo.length; i += 200) {
        const { data, error } = await supabase.from('market_entities').select('id, canonical_name, merged_into_id')
          .eq('workspace_id', workspaceId).in('id', todo.slice(i, i + 200));
        if (error) throw error;
        for (const r of data ?? []) {
          rows.set(r.id, r);
          if (r.merged_into_id && !rows.has(r.merged_into_id)) next.push(r.merged_into_id);
        }
      }
      todo = [...new Set(next)];
    }
    for (const id of want) {
      let cur = rows.get(id), guard = 0;
      while (cur?.merged_into_id && rows.has(cur.merged_into_id) && guard++ < 5) cur = rows.get(cur.merged_into_id);
      if (cur?.canonical_name) out.set(id, cur.canonical_name);
    }
  } catch (e) {
    if (!marketEntitiesMissing(e)) console.warn('[MARKET_ENTITIES] canonical names failed:', (e as Error)?.message ?? e);
    return new Map();
  }
  return out;
}
