import type { SupabaseClient } from '@supabase/supabase-js';
import { searchClaims } from './search.js';
import { isOurSideClaim } from './claimCategories.js';
import { rawVisible, type ReadContext } from './readContext.js';
import { derivedViewerForContext, filterDerivedForViewer } from '../privacy/messagePrivacy.mjs';
import { parseTemporalWindow, stripTemporal, claimInWindow, type TemporalWindow } from './temporalWindow.js';

// Hybrid search over facts (GET-1056): the note.* claims, found five ways and fused into one ranked
// list, so a question finds its facts with or without an OpenAI key.
//
// searchClaims (search.ts) is embedding-only: no key, no results, and even with one it misses the
// exact-word questions ("who mentioned SOC 2"), names ("what did Harborline say") and dated ones
// ("pricing last month"). The design is Hindsight's recall (MIT, github.com/vectorize-io/hindsight:
// search/fusion.py, sql/postgresql.py, temporal_periods.py, fact_budget.py, link_expansion.py;
// notice in THIRD_PARTY_NOTICES.md), on our tables:
//
//   semantic  — searchClaims, only when embeddings come back (OPENAI_API_KEY set).
//   keyword   — search_claims_keyword: full text over content + label, ts_rank_cd, terms OR-joined.
//   names     — search_names: pg_trgm over account/person names and market entity names/aliases
//               (GET-1049), returning the facts on the matched records.
//   dates     — when the question names a period (temporalWindow.ts): the facts said or that
//               happened inside it, keyword-ranked within the window, newest first otherwise.
//   expansion — sibling facts on the same account as the top hits of the arms above, scored
//               tanh(shared × 0.5) (Hindsight's entity link score: 1 shared → 0.46, 2 → 0.76).
//
// Fusion is reciprocal rank fusion, k = 60, over the arms that returned something. A window weighs
// more than in Hindsight (±10% there): it is a filter on the dates arm AND a ×2 boost for a fact
// inside it (×0.5 for one dated outside it, ×1 for an undated one). Then greedy token-budget
// packing in rank order: an oversized fact skips itself, not everything behind it, and a search
// that matched something never answers with nothing.
//
// Privacy: the same filter searchClaims applies (filterDerivedForViewer: a fact derived from a
// message the viewer can't read keeps its fact, loses its quote, GET-253/GET-985), plus rawVisible
// on a document's owner, applied once to the fused list before packing. Every RPC is service-role
// only; RLS on claims stays on.

export type HybridArm = 'semantic' | 'keyword' | 'names' | 'dates' | 'expansion';

/** One fact as an arm returns it. Only id is required; the rest fills in from whichever arm had it. */
export interface ArmHit {
  id: string;
  entity_id: string;
  property?: string;
  value?: unknown;
  valid_from?: string | null;
  confidence?: number;
  freshness?: string;
  supporting_observation_ids?: string[];
  similarity?: number;       // semantic arm
  rank?: number;             // keyword / names arm score
  matched_name?: string;     // names arm
  score?: number;            // expansion arm
}

export interface HybridHit extends ArmHit {
  /** The fused score after the window boost. Comparable within one search only. */
  fused: number;
  /** 1-based rank in each arm that found it. */
  arms: Partial<Record<HybridArm, number>>;
  /** true / false when the question named a window and the fact is dated; absent otherwise. */
  in_window?: boolean;
  /** Estimated tokens the fact's text spends. */
  tokens: number;
}

export interface HybridSearchResult {
  hits: HybridHit[];
  window: TemporalWindow | null;
  /** How many facts each arm returned (before fusion). */
  arms: Partial<Record<HybridArm, number>>;
  /** Tokens the returned facts spend. Exceeds maxTokens only when the never-empty floor applied. */
  total_tokens: number;
  /** A ranked fact was dropped to stay inside the token budget or the limit. */
  truncated: boolean;
}

export interface HybridSearchOptions {
  /** Max facts returned (default 20, cap 300). */
  limit?: number;
  /** Token budget for the returned facts' text (default unbounded). */
  maxTokens?: number;
  /** "Now" for the date window (default the current time). */
  anchor?: Date | string | number | null;
  readContext?: ReadContext;
  /** Skip the semantic arm (it costs an embedding call). Default: run it. */
  semantic?: boolean;
  /** Per-arm candidate cap (default max(limit × 2, 50), cap 200). */
  armLimit?: number;
  onFailure?: (reason: string) => void;
}

export const RRF_K = 60;
export const WINDOW_BOOST = 2;
export const OUTSIDE_WINDOW_FACTOR = 0.5;
/** Top fused hits whose accounts seed the expansion arm. */
export const EXPANSION_SEEDS = 10;
/** Fan-out caps: accounts expanded, sibling facts per account, sibling facts in all. */
export const EXPANSION_MAX_ACCOUNTS = 5;
export const EXPANSION_PER_ACCOUNT = 10;
export const EXPANSION_MAX = 30;
const MAX_NAME_TERMS = 24;

// ── Pure parts (exported for the tests) ────────────────────────────────────────────────────────

/**
 * Reciprocal rank fusion (Hindsight search/fusion.py): score(d) = Σ 1 / (k + rank_in_arm(d)), over
 * the arms given, each already best-first. The first arm to carry a fact supplies its row; later
 * arms fill in fields it lacked (the semantic arm has confidence, the keyword arm the source ids).
 * Ties break on id so the order is stable.
 */
export function rrfFuse(lists: Partial<Record<HybridArm, ArmHit[]>>, k: number = RRF_K): HybridHit[] {
  const byId = new Map<string, HybridHit>();
  for (const [arm, hits] of Object.entries(lists) as [HybridArm, ArmHit[] | undefined][]) {
    if (!hits?.length) continue;
    const seen = new Set<string>();
    let rank = 0;
    for (const h of hits) {
      if (!h?.id || seen.has(h.id)) continue;   // a fact counts once per arm, at its best rank
      seen.add(h.id);
      rank += 1;
      let cur = byId.get(h.id);
      if (!cur) { cur = { ...h, fused: 0, arms: {}, tokens: 0 }; byId.set(h.id, cur); }
      else for (const [f, v] of Object.entries(h)) if ((cur as any)[f] == null && v != null) (cur as any)[f] = v;
      cur.fused += 1 / (k + rank);
      cur.arms[arm] = rank;
    }
  }
  return [...byId.values()].sort(byFused);
}

const byFused = (a: HybridHit, b: HybridHit) => (b.fused - a.fused) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The window boost: ×2 inside, ×0.5 dated outside, ×1 undated. Returns a new, re-sorted list. */
export function applyWindowBoost(hits: HybridHit[], window: Pick<TemporalWindow, 'start' | 'end'> | null): HybridHit[] {
  if (!window) return hits;
  return hits.map(h => {
    const inside = claimInWindow(h, window);
    if (inside == null) return h;
    return { ...h, in_window: inside, fused: h.fused * (inside ? WINDOW_BOOST : OUTSIDE_WINDOW_FACTOR) };
  }).sort(byFused);
}

/** The text a fact spends tokens on: its content, else its label. */
export function factText(h: { value?: unknown }): string {
  const v = h.value as { content?: unknown; label?: unknown } | null | undefined;
  if (v && typeof v === 'object') return String(v.content ?? v.label ?? '');
  return v == null ? '' : String(v);
}

/** The repo's token estimate (chars / 4, as meta.token_estimate elsewhere). */
export const estimateTokens = (text: string): number => Math.ceil(String(text ?? '').length / 4);

/**
 * Greedy budget packing in rank order (Hindsight fact_budget.py): spend `maxTokens` front to back,
 * an oversized fact skips itself and the loop goes on (skip, not break), stop at `limit`. When
 * nothing fits but something matched, the top-ranked fact is returned whole and over budget: an
 * empty answer reads as "we know nothing", a clipped one as a fact nobody said.
 * A non-positive or missing budget means unbounded (only `limit` applies).
 */
export function selectWithinBudget<T extends { tokens: number }>(ordered: T[], maxTokens: number | undefined, limit: number): { selected: T[]; total: number; truncated: boolean } {
  const budget = maxTokens != null && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : Infinity;
  const selected: T[] = [];
  let total = 0;
  let truncated = false;
  for (const h of ordered) {
    if (selected.length >= limit) { truncated = true; break; }
    if (total + h.tokens > budget) { truncated = true; continue; }
    total += h.tokens;
    selected.push(h);
  }
  if (!selected.length && ordered.length && limit > 0) {
    selected.push(ordered[0]);
    total = ordered[0].tokens;
  }
  return { selected, total, truncated };
}

/**
 * Expansion scores: each seed hit votes for its account; a sibling fact on an account scores
 * tanh(shared × 0.5), shared = how many seeds sit on that account (Hindsight link_expansion.py).
 * `accountOf` maps an entity to its account (a person to their company, an account to itself;
 * an entity with no account is its own). Returns account → score for the top accounts.
 */
export function expansionAccountScores(seedEntityIds: string[], accountOf: Map<string, string>, maxAccounts = EXPANSION_MAX_ACCOUNTS): Map<string, number> {
  const shared = new Map<string, number>();
  for (const e of seedEntityIds) {
    const a = accountOf.get(e) ?? e;
    shared.set(a, (shared.get(a) ?? 0) + 1);
  }
  return new Map([...shared.entries()]
    .sort((x, y) => (y[1] - x[1]) || (x[0] < y[0] ? -1 : 1))
    .slice(0, maxAccounts)
    .map(([a, n]) => [a, Math.tanh(n * 0.5)]));
}

const STOPWORDS = new Set((
  'a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its ' +
  'me my no not of on or our she so than that the their them then there these they this those to us was we were what ' +
  'when where which who whom why will with would you your about any all also ever just more most much some such very ' +
  'say said says tell told talk talked talking mention mentioned mentions discuss discussed know think thought want ' +
  'wants anyone anybody someone everyone accounts account people person customers customer prospect prospects deal ' +
  'deals company companies facts fact anything something thing things get got give find show list ' +
  'week weeks month months year years day days quarter ago last next today yesterday'
).split(/\s+/));

/** The words of a question, lowercased, punctuation off (keeps & ' . - inside a name). */
export function questionTokens(q: string): string[] {
  return String(q ?? '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}&'.-]+/u)
    .map(t => t.replace(/^[&'.-]+|[&'.-]+$/g, '').replace(/'s$/, ''))
    .filter(Boolean);
}

/**
 * The spans the names arm looks up: 1–3 consecutive words of the question. A one-word span must be
 * 3+ characters and not a stopword; a longer one must not start or end on a stopword ("of the").
 * Longest first, so "pearl lantern" is tried before "pearl". Capped at 24.
 */
export function nameTerms(q: string): string[] {
  const toks = questionTokens(q);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= toks.length; i++) {
      const span = toks.slice(i, i + n);
      if (STOPWORDS.has(span[0]) || STOPWORDS.has(span[n - 1])) continue;
      const s = span.join(' ');
      if (s.length < 3 || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out.slice(0, MAX_NAME_TERMS);
}

/**
 * What the keyword arm searches for: the question's words minus the stopwords above (which also
 * drops the question's own verbs, "say", "mention", that would otherwise OR-match half the facts).
 * Postgres stems and drops its own English stopwords on top. Empty when nothing is left.
 */
export const keywordQuery = (q: string): string => questionTokens(q).filter(t => t.length >= 2 && !STOPWORDS.has(t)).join(' ');

// ── The search ────────────────────────────────────────────────────────────────────────────────

// Facts only: not documents, and not what OUR side said (GET-1052) — a cross-account search for
// "who wants off Clay" must not answer with our own pitch line.
const isFact = (h: ArmHit): boolean => {
  const v = h.value as { content?: unknown; metadata?: { doc_type?: unknown } } | null | undefined;
  return !!h.entity_id && !!v && typeof v === 'object' && !!v.content && !v.metadata?.doc_type && !isOurSideClaim(v as Record<string, unknown>);
};

/** An RPC arm. A missing function (migration not applied) is an empty arm, silently, like searchClaims. */
async function rpcArm(supabase: SupabaseClient, fn: string, args: Record<string, unknown>, onFailure?: (r: string) => void): Promise<ArmHit[]> {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) {
      if ((error as any).code === '42883' || (error as any).code === 'PGRST202') return [];
      console.error(`[hybridSearchClaims] ${fn}:`, error.message);
      onFailure?.(`${fn}: ${error.message}`);
      return [];
    }
    return ((data as ArmHit[]) ?? []).filter(isFact);
  } catch (e) {
    onFailure?.(`${fn}: ${(e as Error)?.message ?? e}`);
    return [];
  }
}

/**
 * The expansion arm: the accounts of the seed hits, then their facts and their people's facts,
 * scored by how many seeds the account holds. Two small reads on entity_list_rows, one on claims.
 */
async function expansionArm(supabase: SupabaseClient, workspaceId: string, seeds: ArmHit[]): Promise<ArmHit[]> {
  const seedEntities = seeds.map(s => s.entity_id).filter(Boolean);
  if (!seedEntities.length) return [];
  try {
    const uniq = [...new Set(seedEntities)];
    const { data: rows } = await supabase.from('entity_list_rows')
      .select('entity_id, kind, company_id')
      .eq('workspace_id', workspaceId).in('entity_id', uniq).in('kind', ['account', 'person']);
    const accountOf = new Map<string, string>();
    for (const r of (rows as any[]) ?? []) {
      if (r.kind === 'account') accountOf.set(r.entity_id, r.entity_id);
      else if (r.kind === 'person' && r.company_id && !accountOf.has(r.entity_id)) accountOf.set(r.entity_id, r.company_id);
    }
    const scores = expansionAccountScores(seedEntities, accountOf);
    if (!scores.size) return [];
    const accounts = [...scores.keys()];
    // The people on those accounts: their facts are the account's too.
    const { data: people } = await supabase.from('entity_list_rows')
      .select('entity_id, company_id')
      .eq('workspace_id', workspaceId).eq('kind', 'person').in('company_id', accounts).limit(200);
    const owner = new Map<string, string>(accounts.map(a => [a, a]));
    for (const p of (people as any[]) ?? []) if (p.company_id && !owner.has(p.entity_id)) owner.set(p.entity_id, p.company_id);
    const { data: claims } = await supabase.from('claims')
      .select('id, entity_id, property, value, valid_from, confidence, freshness, supporting_observation_ids')
      .eq('workspace_id', workspaceId).in('entity_id', [...owner.keys()])
      .like('property', 'note.%').is('invalid_at', null)
      .order('valid_from', { ascending: false, nullsFirst: false })
      .limit(EXPANSION_MAX * 4);
    const perAccount = new Map<string, number>();
    const out: ArmHit[] = [];
    for (const c of ((claims as ArmHit[]) ?? []).filter(isFact)) {
      const a = owner.get(c.entity_id);
      if (!a) continue;
      const n = perAccount.get(a) ?? 0;
      if (n >= EXPANSION_PER_ACCOUNT) continue;
      perAccount.set(a, n + 1);
      out.push({ ...c, score: scores.get(a) ?? 0 });
      if (out.length >= EXPANSION_MAX) break;
    }
    // Best account first; within one, newest first (the claims read is already newest first).
    return out.map((h, i) => ({ h, i })).sort((x, y) => ((y.h.score ?? 0) - (x.h.score ?? 0)) || (x.i - y.i)).map(x => x.h);
  } catch {
    return [];   // expansion is a bonus; never fail the search for it
  }
}

/**
 * Hybrid search over the workspace's facts. Works with no OpenAI key (the semantic arm is simply
 * absent). See the header for the arms, the fusion and the privacy rule.
 */
export async function hybridSearchClaims(
  supabase: SupabaseClient,
  workspaceId: string,
  query: string,
  opts: HybridSearchOptions = {},
): Promise<HybridSearchResult> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), 300);
  const armLimit = Math.min(Math.max(Math.floor(opts.armLimit ?? Math.max(limit * 2, 50)), 1), 200);
  const q = String(query ?? '').trim();
  const empty: HybridSearchResult = { hits: [], window: null, arms: {}, total_tokens: 0, truncated: false };
  if (!q) return empty;

  const window = parseTemporalWindow(q, opts.anchor);
  const residual = window ? stripTemporal(q, window) : q;
  const kq = keywordQuery(residual);
  const residualHasTerms = kq.length > 0;
  const terms = nameTerms(residual);

  const [semantic, keyword, names, dates] = await Promise.all([
    opts.semantic === false ? Promise.resolve([] as ArmHit[])
      // No ctx here: privacy is applied once, to the fused list, below.
      : searchClaims(supabase, workspaceId, q, { propertyPrefix: 'note.', limit: armLimit, threshold: 0.3, onFailure: opts.onFailure })
          .then(h => (h as ArmHit[]).filter(isFact)).catch(() => [] as ArmHit[]),
    residualHasTerms
      ? rpcArm(supabase, 'search_claims_keyword', { ws: workspaceId, q: kq, lim: armLimit, since: null, until: null }, opts.onFailure)
      : Promise.resolve([] as ArmHit[]),
    terms.length
      ? rpcArm(supabase, 'search_names', { ws: workspaceId, terms, lim: armLimit }, opts.onFailure)
      : Promise.resolve([] as ArmHit[]),
    window
      ? (async () => {
          const args = { ws: workspaceId, lim: armLimit, since: window.start, until: window.end };
          // Inside the window, keyword-ranked; when no fact in it matches the words (or there are
          // none, "what happened last week"), the window's facts newest first.
          const ranked = residualHasTerms ? await rpcArm(supabase, 'search_claims_keyword', { ...args, q: kq }, opts.onFailure) : [];
          return ranked.length ? ranked : rpcArm(supabase, 'search_claims_keyword', { ...args, q: '' }, opts.onFailure);
        })()
      : Promise.resolve([] as ArmHit[]),
  ]);

  const base: Partial<Record<HybridArm, ArmHit[]>> = { semantic, keyword, names, dates };
  const seeds = rrfFuse(base).slice(0, EXPANSION_SEEDS);
  const expansion = await expansionArm(supabase, workspaceId, seeds);
  const arms: Partial<Record<HybridArm, number>> = {};
  for (const [k, v] of Object.entries({ ...base, expansion })) if (v?.length) arms[k as HybridArm] = v.length;

  let fused = applyWindowBoost(rrfFuse({ ...base, expansion }), window);
  // Bound the privacy reads: only a few times what can be returned is ever looked at.
  fused = fused.slice(0, Math.max(limit * 3, 60));

  // Privacy, the same rules as searchClaims (+ a document's owner, as /v2/notes/search).
  const ctx = opts.readContext;
  if (ctx) fused = fused.filter(h => rawVisible((h.value as any)?.metadata?.owner_user_id ?? null, ctx));
  const viewer = await derivedViewerForContext(supabase, ctx);
  if (viewer && fused.length) fused = (await filterDerivedForViewer(supabase, workspaceId, fused, viewer)) as HybridHit[];

  for (const h of fused) h.tokens = estimateTokens(factText(h));
  const { selected, total, truncated } = selectWithinBudget(fused, opts.maxTokens, limit);
  return { hits: selected, window, arms, total_tokens: total, truncated };
}
