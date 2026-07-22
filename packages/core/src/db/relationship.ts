import type { SupabaseClient } from '@supabase/supabase-js';
import { assertClaims } from './claims.js';

// Relationship classification, orthogonal to pipeline activity. A contact is not
// automatically a lead: a LinkedIn connection you accepted, or a friend you talk to,
// is someone you KNOW — not a deal you're working. `is_personal` marks those people
// so no deal-risk, lost-deal, or going-dark logic ever applies to them. It is the
// human-set counterpart to is_internal (teammates): where is_internal is recognised
// automatically from workspace membership, is_personal is the user's own call, for the
// one case inference can't catch — a high-fit friend who WOULD look like a lead.
//
// Stored as an asserted `is_personal = true` claim on the person entity. Asserted
// claims are sticky (the derivation engine never overwrites them, see recomputeClaim),
// so the flag survives re-derivation. Reversible: unmarking invalidates the claim.

export const IS_PERSONAL = 'is_personal';

/** Mark (on=true) or unmark (on=false) a person as personal/network — not a deal.
 *  Idempotent. Unmark invalidates the claim (assertClaims treats null as soft-delete). */
export async function markEntityPersonal(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  on = true,
): Promise<void> {
  await assertClaims(supabase, workspaceId, entityId, {
    values: { [IS_PERSONAL]: on ? true : null },
    source: 'user',
  });
}

/** The entity ids on this workspace currently flagged personal. Used to exclude
 *  personal/network contacts from deal-risk, scoring, and pipeline surfaces. */
export async function getPersonalEntityIds(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('claims')
    .select('entity_id, value')
    .eq('workspace_id', workspaceId)
    .eq('property', IS_PERSONAL)
    .is('invalid_at', null);
  if (error) throw new Error(`failed to load personal entities: ${error.message}`);
  const ids = new Set<string>();
  for (const row of (data as { entity_id: string; value: unknown }[]) ?? []) {
    if (row.value === true) ids.add(row.entity_id);
  }
  return ids;
}

/** True if this single entity is flagged personal. */
export async function isEntityPersonal(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('claims')
    .select('value')
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .eq('property', IS_PERSONAL)
    .is('invalid_at', null)
    .maybeSingle();
  return (data as { value?: unknown } | null)?.value === true;
}
