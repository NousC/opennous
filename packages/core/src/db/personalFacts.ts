import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeClaimCategory, categoriesInDomain } from './claimCategories.js';

// What a personal mark takes off the record (GET-1016). GET-1014 stopped extraction from filing new
// deal facts about someone marked personal; the ones already on file stayed, so the account kept its
// "Budget discussed". Marking now retires them: invalid_at, never a delete, and each one is stamped
// with whose mark retired it, so unmarking brings back exactly those and nothing else.
//
// The deal facts: the deal domain (objections, budget, timeline, buying signals, competitors,
// blockers, requirements), plus the stakeholder roles and the two CS signals. What describes the
// person or the company (preferences, relationships, the stack, firmographics) is still true of
// someone we know, so it stays. Documents stay. Tasks (action_item.*) stay: they are the user's.

export const PERSONAL_RETIRED_CATEGORIES: readonly string[] = [
  ...categoriesInDomain('deal'), 'authority', 'expansion_signal', 'risk_signal',
];
const RETIRED = new Set(PERSONAL_RETIRED_CATEGORIES);
/** The metadata key on a fact a personal mark retired: the id of the entity whose mark it was. */
export const RETIRED_FOR_PERSONAL = 'retired_for_personal';

type FactRow = { id: string; entity_id: string; value: Record<string, unknown> | null };

/** True for a live fact a personal mark retires. Pure. */
export function isPersonalRetirable(value: Record<string, unknown> | null | undefined): boolean {
  if (!value || typeof value !== 'object') return false;
  const meta = (value.metadata ?? {}) as Record<string, unknown>;
  if (meta.doc_type) return false;
  return RETIRED.has(normalizeClaimCategory(String(value.category ?? '')));
}

async function rows<T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data as T[] | null) ?? [];
}

const PAGE = 1000;   // PostgREST's row cap: read past it page by page, never trust one read
const CHUNK = 100;   // ids per `in` filter, so a large account's list stays inside one URL

/** Every row of a query, page by page in id order. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any supabase-js filter builder
async function allRows<T>(query: () => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await rows<T>(query().order('id').range(from, from + PAGE - 1));
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

const chunks = <T>(xs: T[]): T[][] => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

/** The live deal facts a mark on this entity retires: its own, and for a company its people's;
 *  for a person, also what they voiced that was filed on their company. */
export async function personalFactsFor(supabase: SupabaseClient, workspaceId: string, entityId: string): Promise<FactRow[]> {
  // Documents are never retired, so they are left out in the query, not after it.
  const notes = () => supabase.from('claims').select('id, entity_id, value')
    .eq('workspace_id', workspaceId).like('property', 'note.%').is('invalid_at', null)
    .is('value->metadata->>doc_type', null);
  const people = await allRows<{ id: string }>(() => supabase.from('contacts').select('id')
    .eq('workspace_id', workspaceId).eq('company_id', entityId));
  const found: FactRow[] = [];
  for (const ids of chunks([entityId, ...people.map(p => p.id)])) {
    found.push(...await allRows<FactRow>(() => notes().in('entity_id', ids)));
  }
  if (!people.length) {
    // A person (or a company with no one at it): the company facts they voiced
    // (voiced_by_contact_id) carry their words too.
    const me = await rows<{ company_id: string | null }>(supabase.from('contacts').select('company_id')
      .eq('workspace_id', workspaceId).eq('id', entityId));
    const companyId = me[0]?.company_id;
    if (companyId) {
      found.push(...await allRows<FactRow>(() => notes().eq('entity_id', companyId)
        .eq('value->metadata->>voiced_by_contact_id', entityId)));
    }
  }
  return found.filter(f => isPersonalRetirable(f.value));
}

/** Retire the deal facts on file for an entity just marked personal. Returns how many. */
export async function retirePersonalFacts(supabase: SupabaseClient, workspaceId: string, entityId: string): Promise<number> {
  const facts = await personalFactsFor(supabase, workspaceId, entityId);
  const at = new Date().toISOString();
  let n = 0;
  for (const f of facts) {
    const value = f.value ?? {};
    const metadata = { ...((value.metadata ?? {}) as Record<string, unknown>), [RETIRED_FOR_PERSONAL]: entityId };
    const { error } = await supabase.from('claims').update({ invalid_at: at, value: { ...value, metadata } })
      .eq('id', f.id).eq('workspace_id', workspaceId).is('invalid_at', null);
    if (error) throw new Error(`could not retire ${f.id}: ${error.message}`);
    n++;
  }
  return n;
}

/** Bring back what this entity's personal mark retired, now that it is unmarked. Returns how many.
 *  A fact still covered by another mark (its person, or the company they work at, is still
 *  personal) stays retired and passes to that mark, so unmarking that one brings it back. */
export async function restorePersonalFacts(supabase: SupabaseClient, workspaceId: string, entityId: string): Promise<number> {
  const retired = await allRows<FactRow>(() => supabase.from('claims').select('id, entity_id, value')
    .eq('workspace_id', workspaceId).like('property', 'note.%').not('invalid_at', 'is', null)
    .eq(`value->metadata->>${RETIRED_FOR_PERSONAL}`, entityId));
  if (!retired.length) return 0;
  const marked = new Set((await allRows<{ entity_id: string; value: unknown }>(() => supabase.from('claims').select('entity_id, value')
    .eq('workspace_id', workspaceId).eq('property', 'is_personal').is('invalid_at', null)))
    .filter(c => c.value === true).map(c => c.entity_id));
  marked.delete(entityId);
  const companyOf = new Map<string, string | null>();
  for (const ids of chunks([...new Set(retired.map(f => f.entity_id))])) {
    for (const c of await rows<{ id: string; company_id: string | null }>(supabase.from('contacts').select('id, company_id')
      .eq('workspace_id', workspaceId).in('id', ids))) companyOf.set(c.id, c.company_id);
  }
  let n = 0;
  for (const f of retired) {
    const value = f.value ?? {};
    const { [RETIRED_FOR_PERSONAL]: _, ...metadata } = (value.metadata ?? {}) as Record<string, unknown>;
    const company = companyOf.get(f.entity_id) ?? null;
    const holder = marked.has(f.entity_id) ? f.entity_id : company && marked.has(company) ? company : null;
    const { error } = holder
      ? await supabase.from('claims').update({ value: { ...value, metadata: { ...metadata, [RETIRED_FOR_PERSONAL]: holder } } })
        .eq('id', f.id).eq('workspace_id', workspaceId)
      : await supabase.from('claims').update({ invalid_at: null, value: { ...value, metadata } })
        .eq('id', f.id).eq('workspace_id', workspaceId);
    if (error) throw new Error(`could not restore ${f.id}: ${error.message}`);
    if (!holder) n++;
  }
  return n;
}
