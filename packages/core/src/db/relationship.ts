import type { SupabaseClient } from '@supabase/supabase-js';
import { assertClaims } from './claims.js';
import { normalizeStage } from '../pipeline.js';
// @ts-ignore -- a plain .mjs module, carried into dist by allowJs
import { personalAccountIds } from './accountOverview.mjs';
import { retirePersonalFacts, restorePersonalFacts } from './personalFacts.js';
import { rereadSlackSince } from './personalReread.js';

// The sales funnel — the only stages that are a DEAL. Every stage on the canonical
// ladder counts, plus its terminals: `closed_won` (a paying customer, set by the
// Stripe webhook), `closed_lost`, `disqualified` and `churned`. A signup lands in a
// product stage instead (default_signup_stage, e.g. "Free User"), which is not a
// stage at all — that is exactly what marks it a product user.
//
// Membership is decided by normalizeStage(), not by matching the stage set directly.
// The DB has not been migrated yet, so live rows still hold `aware`, `evaluating`,
// `proposal`, `client` and `lost`. A raw match would read every one of those as "not
// a sales stage" and silently reclassify real deals as product users, which drops
// them out of pipeline analysis, attention and reporting. normalizeStage() resolves
// the legacy names and returns null only for something that is genuinely not a
// funnel stage.

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

/** Mark (on=true) or unmark (on=false) a person or company as personal/network — not a deal.
 *  Idempotent. Unmark invalidates the claim (assertClaims treats null as soft-delete). Marking
 *  retires the deal facts already on file for them; unmarking brings those back (GET-1016). */
export async function markEntityPersonal(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  on = true,
): Promise<void> {
  // When the mark went on: what was read since then skipped them, so it is read again (GET-1024).
  const { data: marks } = on ? { data: null } : await supabase.from('claims').select('valid_from')
    .eq('workspace_id', workspaceId).eq('entity_id', entityId).eq('property', IS_PERSONAL)
    .is('invalid_at', null).order('valid_from').limit(1);
  const mark = marks?.[0] as { valid_from?: string } | undefined;
  await assertClaims(supabase, workspaceId, entityId, {
    values: { [IS_PERSONAL]: on ? true : null },
    source: 'user',
  });
  if (on) await retirePersonalFacts(supabase, workspaceId, entityId);
  else {
    await restorePersonalFacts(supabase, workspaceId, entityId);
    if (mark?.valid_from) await rereadSlackSince(supabase, workspaceId, entityId, mark.valid_from);
  }
}

/** The entity ids on this workspace currently flagged personal, plus the Network accounts: a
 *  company whose people are all marked is someone we know too (GET-1017). Used to exclude
 *  personal/network contacts and accounts from deal-risk, scoring, events and pipeline surfaces. */
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
  for (const id of await personalAccountIds(supabase, workspaceId) as Set<string>) ids.add(id);
  return ids;
}

/** Entity ids whose current pipeline_stage is a PRODUCT-USER stage — a signup like
 *  "Free User" / "User", i.e. any value that is not one of the sales-funnel stages.
 *  These are users of the product, not deals: they're counted, but excluded from
 *  pipeline analysis. A paying customer is `closed_won` (a sales stage), so they are
 *  NOT here — only free/product signups are. Derived from stage, so it needs no
 *  manual tag. */
export async function getProductUserEntityIds(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('claims')
    .select('entity_id, value')
    .eq('workspace_id', workspaceId)
    .eq('property', 'pipeline_stage')
    .is('invalid_at', null);
  if (error) throw new Error(`failed to load product-user entities: ${error.message}`);
  const ids = new Set<string>();
  for (const row of (data as { entity_id: string; value: unknown }[]) ?? []) {
    const v = row.value;
    const stage = typeof v === 'string' ? v : (v && typeof v === 'object' ? String((v as any).value ?? '') : '');
    // normalizeStage() lowercases and resolves legacy names itself; null means the
    // value is not a funnel stage at all, which is what makes this a product user.
    if (stage && !normalizeStage(stage)) ids.add(row.entity_id);
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

/** True if this contact is personal, or works at a company marked personal (GET-1014). A call or
 *  message with them is someone we know, not a deal: extraction reads it for insights only, never
 *  for buying signals, objections or stakeholders. */
export async function isContactPersonal(
  supabase: SupabaseClient,
  workspaceId: string,
  contactId: string,
): Promise<boolean> {
  if (await isEntityPersonal(supabase, workspaceId, contactId)) return true;
  const { data } = await supabase
    .from('contacts')
    .select('company_id')
    .eq('workspace_id', workspaceId)
    .eq('id', contactId)
    .maybeSingle();
  const companyId = (data as { company_id?: string | null } | null)?.company_id;
  return companyId ? isEntityPersonal(supabase, workspaceId, companyId) : false;
}
