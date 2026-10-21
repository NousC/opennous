import type { SupabaseClient } from '@supabase/supabase-js';
import { embedBatch } from '../embed.js';

// Claims about us (GET-969) — what a customer said about OUR product, pitch or market, heard once.
//
// The claim read already sorted every statement into a home (GET-775): a fact about them, feedback
// on our product, or a view of the market. It filed the first and counted the other two away, and a
// second read of the same transcript (the insight read) re-derived them with its own quotes. Now the
// one read keeps them, with the same quote check, and with the fields an insight is counted on:
// what was asked for, the use case, the product area, who asked, and the job behind a pain.
//
// They live here, not in `claims`: a claim about us is not a fact about their account, and the
// account record must not show "wants a date filter" as the customer's pain (the GET-775 bug). The
// insight engine (GET-971) groups and counts these across accounts.

/** What kind of point it is: the board's ten (insightBoard.ts), plus praise. */
export const ABOUT_US_KINDS = ['bug', 'friction', 'feature', 'objection', 'pricing', 'pitch', 'setup', 'training', 'partners', 'buyers', 'praise'] as const;
export type AboutUsKind = (typeof ABOUT_US_KINDS)[number];
const KIND_SET = new Set<string>(ABOUT_US_KINDS);
const KIND_ALIASES: Record<string, AboutUsKind> = {
  request: 'feature', feature_request: 'feature', improvement: 'friction', competitor: 'partners', competitors: 'partners',
  partner: 'partners', buyer: 'buyers', market: 'buyers', positioning: 'pitch', messaging: 'pitch', price: 'pricing',
  onboarding: 'setup', adoption: 'training',
};

/** A kind the engine knows, or the default for its home: product feedback is a request, a market
 *  view is about buyers. Pure. */
export function normalizeAboutUsKind(kind: unknown, home: 'our_product' | 'market' = 'our_product'): AboutUsKind {
  const k = String(kind ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (KIND_SET.has(k)) return k as AboutUsKind;
  if (KIND_ALIASES[k]) return KIND_ALIASES[k];
  return home === 'market' ? 'buyers' : 'feature';
}

export interface AboutUsFact {
  content: string;
  quote: string | null;
  speaker?: string | null;
  home?: string | null;
  kind?: string | null;
  what?: string | null;
  use_case?: string | null;
  product_area?: string | null;
  asked_by?: string | null;
  job?: string | null;
  contactId?: string | null;
  companyId?: string | null;
}

export interface AboutUsContext {
  sourceRef?: string | null;
  sourceSystem?: string | null;
  occurredAt?: string | null;
  /** 'claim_read' (this read) or 'insight_read' (copied from insight_items). */
  origin?: 'claim_read' | 'insight_read';
  /** Said in a private message: the fact is the team's, the words stay private (GET-985). */
  quotePrivate?: boolean;
}

const text = (v: unknown, max: number): string | null => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return s ? s.slice(0, max) : null;
};

/** The row for one fact. Null when it has nothing to stand on: no sentence, or no checked quote
 *  (an insight rests on their own words, GET-974). Pure. */
export function aboutUsRow(workspaceId: string, f: AboutUsFact, ctx: AboutUsContext = {}): Record<string, unknown> | null {
  const content = text(f?.content, 600);
  const quote = text(f?.quote, 1000);
  if (!content || !quote) return null;
  const home = f.home === 'market' ? 'market' : 'our_product';
  return {
    workspace_id: workspaceId,
    company_id: f.companyId ?? null,
    contact_id: f.contactId ?? null,
    home,
    kind: normalizeAboutUsKind(f.kind, home),
    content,
    quote,
    speaker: text(f.speaker, 200),
    what: text(f.what, 120),
    use_case: text(f.use_case, 300),
    product_area: text(f.product_area, 80),
    asked_by: text(f.asked_by, 120),
    // The job behind a pain is the model's reading, not their words: kept apart from the quote.
    job: text(f.job, 300),
    source_ref: ctx.sourceRef ?? null,
    source_system: ctx.sourceSystem ?? null,
    occurred_at: ctx.occurredAt ?? null,
    origin: ctx.origin ?? 'claim_read',
    quote_private: !!ctx.quotePrivate,
  };
}

/** Repeats of one point within one source (as GET-974 for insights): rewordings sit at 0.85+. */
export const ABOUT_US_REPEAT_SIMILARITY = 0.85;

export function cosine(a: number[], b: number[]): number {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? d / Math.sqrt(x * y) : 0;
}

/** A vector as PostgREST returns it: an array, or the text "[0.1,0.2,…]". */
export function parseVector(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v !== 'string' || !v.startsWith('[')) return null;
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : null; } catch { return null; }
}

/** The rows that repeat nothing: not one already filed from this source in the same kind, nor one
 *  earlier in the batch. A row with no vector is kept. Pure. */
export function withoutRepeatedPoints<T extends { kind?: unknown }>(
  rows: T[], vecs: (number[] | null)[], existing: { kind: string; vec: number[] | null }[] = [], threshold = ABOUT_US_REPEAT_SIMILARITY,
): { row: T; vec: number[] | null }[] {
  const kept: { row: T; vec: number[] | null }[] = [];
  rows.forEach((row, i) => {
    const vec = vecs[i] ?? null;
    if (vec) {
      const near = (k: unknown, v: number[] | null) => k === row.kind && !!v && cosine(vec, v) >= threshold;
      if (existing.some(e => near(e.kind, e.vec)) || kept.some(k => near(k.row.kind, k.vec))) return;
    }
    kept.push({ row, vec });
  });
  return kept;
}

/**
 * File what a conversation said about us. Best-effort: a failure here never costs the account its
 * claims, so it logs and returns 0. Returns the number of rows written.
 */
export async function saveAboutUsClaims(
  supabase: SupabaseClient, workspaceId: string, facts: AboutUsFact[], ctx: AboutUsContext = {},
): Promise<number> {
  try {
    const rows = (facts ?? []).map(f => aboutUsRow(workspaceId, f, ctx)).filter((r): r is Record<string, unknown> => !!r);
    if (!rows.length) return 0;
    const { data: old, error: readErr } = ctx.sourceRef
      ? await supabase.from('about_us_claims').select('kind, embedding')
        .eq('workspace_id', workspaceId).eq('source_ref', ctx.sourceRef).limit(200)
      : { data: [], error: null };
    if (readErr) { console.warn('[ABOUT_US] read failed:', readErr.message); return 0; }
    const vecs = (await embedBatch(rows.map(r => String(r.content)))) ?? rows.map(() => null);
    const existing = (old ?? []).map((o: any) => ({ kind: String(o.kind), vec: parseVector(o.embedding) }));
    const kept = withoutRepeatedPoints(rows, vecs, existing);
    if (!kept.length) return 0;
    const { error } = await supabase.from('about_us_claims')
      .insert(kept.map(({ row, vec }) => ({ ...row, embedding: vec ? JSON.stringify(vec) : null })));
    if (error) { console.warn('[ABOUT_US] write failed:', error.message); return 0; }
    return kept.length;
  } catch (err: any) {
    console.warn('[ABOUT_US] failed:', err?.message ?? err);
    return 0;
  }
}
