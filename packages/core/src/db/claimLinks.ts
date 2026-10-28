import type { SupabaseClient } from '@supabase/supabase-js';

// Cause-and-effect links between claims (GET-1053).
//
// The extractor may say that one fact it read happened BECAUSE of another fact in the same read
// ("we froze the budget after our CFO left": the frozen budget caused_by the CFO leaving). The
// worker turns those positions into claim ids once the facts are filed (worker
// signals/causeLinks.mjs) and writes them here, one row per (from, to, kind) in `claim_links`
// (migration supabase/migrations/2026_10_27_claim_links.sql). `from_claim_id` is the effect,
// `to_claim_id` the cause: "from caused_by to".
//
// The shape is Hindsight's (retain/fact_extraction.py causal relations and memories/pg/links.py,
// MIT): only `caused_by` is written, the cause always earlier, at most two per fact. A link whose end
// is retired is archived, not deleted (archived_at), by the claims trigger in the migration — every
// path that retires or brings back a claim sets claims.invalid_at, so the trigger covers all of them.
//
// FAIL-SAFE: without the migration (42P01 / PGRST205) every function here does nothing and says
// nothing; extraction and the Intelligence readers proceed exactly as before. Service role only.

export const CLAIM_LINK_KINDS = ['caused_by'] as const;
export type ClaimLinkKind = (typeof CLAIM_LINK_KINDS)[number];

export interface ClaimLinkInput {
  fromClaimId: string;
  toClaimId: string;
  kind?: ClaimLinkKind;
}

export interface ClaimLink {
  id?: string;
  from_claim_id: string;
  to_claim_id: string;
  kind: ClaimLinkKind;
  created_at?: string;
  archived_at?: string | null;
}

const LIST_CHUNK = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The migration is not applied (Postgres 42P01, or PostgREST's PGRST205 schema-cache miss). Pure. */
export function isMissingClaimLinks(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === '42P01' || e.code === 'PGRST205') return true;
  return /claim_links/.test(e.message ?? '') && /schema cache|does not exist/.test(e.message ?? '');
}

/**
 * The links worth writing: both ends real ids, never a claim caused by itself, a known kind, each
 * (from, to, kind) once. Pure.
 */
export function cleanClaimLinks(links: ClaimLinkInput[] | null | undefined): Required<ClaimLinkInput>[] {
  const out: Required<ClaimLinkInput>[] = [];
  const seen = new Set<string>();
  for (const l of links ?? []) {
    const from = String(l?.fromClaimId ?? ''), to = String(l?.toClaimId ?? '');
    const kind = (l?.kind ?? 'caused_by') as ClaimLinkKind;
    if (!UUID_RE.test(from) || !UUID_RE.test(to) || from === to) continue;
    if (!CLAIM_LINK_KINDS.includes(kind)) continue;
    const key = `${from}|${to}|${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ fromClaimId: from, toClaimId: to, kind });
  }
  return out;
}

/**
 * Write cause links. Each end must be a claim in this workspace; a link with a retired end is written
 * already archived (a fact filed as history — an older statement read after a newer one — is retired
 * the moment it is saved, before its links are written, so the trigger never saw it go). Writing a
 * link that exists refreshes its archived_at to the ends' current state. Never throws.
 * @returns how many links were written, and whether the table is missing.
 */
export async function saveClaimLinks(
  supabase: SupabaseClient,
  workspaceId: string,
  links: ClaimLinkInput[] | null | undefined,
): Promise<{ written: number; missing: boolean }> {
  const clean = cleanClaimLinks(links);
  if (!clean.length) return { written: 0, missing: false };
  try {
    const ids = [...new Set(clean.flatMap(l => [l.fromClaimId, l.toClaimId]))];
    const { data: rows, error: e1 } = await supabase.from('claims').select('id, invalid_at')
      .eq('workspace_id', workspaceId).in('id', ids);
    if (e1) { console.warn('[CLAIM_LINKS] could not read the claims:', e1.message); return { written: 0, missing: false }; }
    const live = new Map((rows ?? []).map((r: { id: string; invalid_at: string | null }) => [r.id, r.invalid_at == null]));
    const now = new Date().toISOString();
    const payload = clean
      .filter(l => live.has(l.fromClaimId) && live.has(l.toClaimId))
      .map(l => ({
        workspace_id: workspaceId,
        from_claim_id: l.fromClaimId,
        to_claim_id: l.toClaimId,
        kind: l.kind,
        archived_at: live.get(l.fromClaimId) && live.get(l.toClaimId) ? null : now,
      }));
    if (!payload.length) return { written: 0, missing: false };
    const { error } = await supabase.from('claim_links')
      .upsert(payload, { onConflict: 'workspace_id,from_claim_id,to_claim_id,kind' });
    if (error) {
      if (isMissingClaimLinks(error)) return { written: 0, missing: true };
      console.warn('[CLAIM_LINKS] write failed:', error.message);
      return { written: 0, missing: false };
    }
    return { written: payload.length, missing: false };
  } catch (err) {
    if (isMissingClaimLinks(err)) return { written: 0, missing: true };
    console.warn('[CLAIM_LINKS] write failed:', (err as Error)?.message ?? err);
    return { written: 0, missing: false };
  }
}

/**
 * The live (not archived) links touching any of these claims, either end. [] without the table or on
 * any failure: a reader falls back to what it did before links existed.
 */
export async function listClaimLinks(
  supabase: SupabaseClient,
  workspaceId: string,
  claimIds: string[] | null | undefined,
  { kind = 'caused_by' as ClaimLinkKind, limit = 500 } = {},
): Promise<ClaimLink[]> {
  const ids = [...new Set((claimIds ?? []).filter(id => UUID_RE.test(String(id))))];
  if (!ids.length) return [];
  try {
    // In chunks: both ends are matched with an `in` list in the URL, and a deal's 200 claim ids in
    // one request would be a ~15 KB query string.
    const out: ClaimLink[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < ids.length && out.length < limit; i += LIST_CHUNK) {
      const list = ids.slice(i, i + LIST_CHUNK).join(',');
      const { data, error } = await supabase.from('claim_links')
        .select('id, from_claim_id, to_claim_id, kind, created_at, archived_at')
        .eq('workspace_id', workspaceId).eq('kind', kind).is('archived_at', null)
        .or(`from_claim_id.in.(${list}),to_claim_id.in.(${list})`)
        .limit(limit);
      if (error) {
        if (!isMissingClaimLinks(error)) console.warn('[CLAIM_LINKS] read failed:', error.message);
        return [];
      }
      for (const l of (data ?? []) as ClaimLink[]) {
        const key = l.id ?? `${l.from_claim_id}|${l.to_claim_id}|${l.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(l);
      }
    }
    const want = new Set(ids);
    return out.filter(l => want.has(l.from_claim_id) || want.has(l.to_claim_id)).slice(0, limit);
  } catch (err) {
    if (!isMissingClaimLinks(err)) console.warn('[CLAIM_LINKS] read failed:', (err as Error)?.message ?? err);
    return [];
  }
}
