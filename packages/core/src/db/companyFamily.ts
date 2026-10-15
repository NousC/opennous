// Which companies are the same customer.
//
// A company group is one customer with many front doors. A graph can hold several "Brackenford"
// locations, a few "Tamberlane" and more under "Marlow Bay", each its own company, and HubSpot already records the
// group each belongs to. The CRM sync mirrors that as `subsidiary_of` edges, child → parent.
//
// Readers want one question answered: are these two companies the same customer, and if so which
// of them is the more specific? One level of parent covers a holding company, a franchise network and
// almost every multi-site business; deeper nesting is rare enough that resolving to the immediate
// parent is both cheaper and easier to reason about than walking a tree of unknown depth.

import type { SupabaseClient } from '@supabase/supabase-js';

/** Absent table or column — a workspace whose migration has not landed. Never worth raising. */
const MISSING_SCHEMA = new Set(['42P01', 'PGRST204', 'PGRST205', '42703']);

/**
 * child entity id → parent entity id, for the companies asked about.
 *
 * An empty map is the honest answer for a workspace whose CRM models no hierarchy, one that has
 * not synced since the edges existed, and a failed read. Every caller must behave as it did
 * before hierarchy existed when the map is empty.
 */
export async function loadCompanyParents(
  supabase: SupabaseClient,
  workspaceId: string,
  companyIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set((companyIds ?? []).filter(Boolean).map(String))];
  const out = new Map<string, string>();
  if (!ids.length || !workspaceId) return out;
  try {
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await supabase
        .from('relationships')
        .select('from_entity_id, to_entity_id')
        .eq('workspace_id', workspaceId)
        .eq('type', 'subsidiary_of')
        .in('from_entity_id', ids.slice(i, i + 200));
      if (error) {
        if (!MISSING_SCHEMA.has(String(error.code))) {
          console.warn('[companyFamily] parents not read:', error.message);
        }
        return out;
      }
      for (const row of (data as Array<{ from_entity_id: string; to_entity_id: string }> | null) ?? []) {
        if (row.from_entity_id && row.to_entity_id && !out.has(row.from_entity_id)) {
          out.set(row.from_entity_id, row.to_entity_id);
        }
      }
    }
    return out;
  } catch {
    return out;
  }
}

/**
 * Are `a` and `b` the same customer?
 *
 * True when they are the same company, when one is the other's parent, or when they share one.
 * With no hierarchy loaded this is just equality, which is what every caller did before.
 *
 * Pure, so the rules built on it are testable without a database.
 */
export function sameCompanyFamily(
  a: string | null | undefined,
  b: string | null | undefined,
  parentOf: Map<string, string> = new Map(),
): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = parentOf.get(a) ?? null;
  const pb = parentOf.get(b) ?? null;
  return pa === b || pb === a || (!!pa && pa === pb);
}

/**
 * The more specific of two companies in the same family: the child, not the group.
 *
 * A call with the Kestrel Point location is about Kestrel Point, even when the person who took it writes from the
 * group's domain. Returns null when they are not the same customer — the caller must then decide
 * between them on its own evidence rather than be handed a false winner.
 */
export function mostSpecificInFamily(
  a: string | null | undefined,
  b: string | null | undefined,
  parentOf: Map<string, string> = new Map(),
): string | null {
  if (!sameCompanyFamily(a, b, parentOf)) return null;
  if (a === b) return a ?? null;
  if (parentOf.get(a as string) === b) return a as string;   // a is the child
  if (parentOf.get(b as string) === a) return b as string;   // b is the child
  return a ?? null;                                          // siblings: no reason to prefer either
}
