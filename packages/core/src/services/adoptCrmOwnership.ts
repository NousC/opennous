// When a rep joins, the records that were already theirs become theirs here too (GET-284).
//
// This covers every COMPANY source, because they share one shape: the record names the person by
// EMAIL and cannot name them by seat. HubSpot writes the deal owner's address; Fellow writes the
// call host's address (GET-229) whether or not that host has ever signed in. Both wait here.
//
// A client's CRM is imported before their team has seats: every account, deal and conversation
// arrives carrying the HubSpot owner's EMAIL and no user id, because at import time no user had
// that email. Unowned rows are visible to the whole workspace, which is right for an operator
// setting the workspace up and wrong the moment the real team arrives — their own book should be
// theirs, and a colleague's calls should not sit on their home page.
//
// So joining is the moment to resolve it: match the new member's addresses (their login and any
// mailbox they connect) against the owner email already on the record, and stamp it. Live sync
// already does this for new records — `ownerUserIdFor` — this is the same rule applied backwards
// to what was imported before they existed.
//
// Idempotent, and it never TAKES a record from someone: only rows with no owner are stamped.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getInternalIdentities } from '../db/teamMembers.js';
import { attributeRelationship } from '../db/relationshipOwner.js';

export interface AdoptResult {
  emails: string[];
  activities: number;        // conversations and calls stamped with this member's user id
  accounts: number;          // accounts this member now owns the relationship with
  applied: boolean;
}

/** Every address that belongs to this member in this workspace (login + connected mailboxes). */
async function addressesOf(supabase: SupabaseClient, workspaceId: string, userId: string): Promise<string[]> {
  const ids = await getInternalIdentities(supabase, workspaceId).catch(() => []);
  return [...new Set(ids.filter(i => i.kind === 'email' && i.ownerUserId === userId).map(i => i.value))];
}

/**
 * Give a member the imported records their CRM owner email already names.
 *
 * @param opts.apply write (default true). false reports what it would do.
 */
export async function adoptCrmOwnership(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string,
  opts: { apply?: boolean } = {},
): Promise<AdoptResult> {
  const apply = opts.apply !== false;
  const emails = await addressesOf(supabase, workspaceId, userId);
  const out: AdoptResult = { emails, activities: 0, accounts: 0, applied: apply };
  if (!emails.length) return out;

  for (const email of emails) {
    // ── Conversations and calls: the source told us whose they were, by address. ──
    // `owner_email` is what a CRM logs on an engagement; `host_email` is what a company
    // note-taker logs on a call it recorded for the whole company.
    const ids: string[] = [];
    for (const field of ['owner_email', 'host_email']) {
      const { data: rows } = await supabase.from('observations')
        .select('id')
        .eq('workspace_id', workspaceId)
        .is('owner_user_id', null)
        .eq(`raw->>${field}`, email)
        .limit(50_000);
      for (const r of rows ?? []) ids.push((r as { id: string }).id);
    }
    out.activities += ids.length;
    if (apply) {
      for (let i = 0; i < ids.length; i += 500) {
        await supabase.from('observations').update({ owner_user_id: userId }).in('id', ids.slice(i, i + 500));
      }
    }

    // ── Accounts: the deals they own name their accounts. ──
    const { data: ownerClaims } = await supabase.from('claims')
      .select('entity_id')
      .eq('workspace_id', workspaceId)
      .eq('property', 'owner_email')
      .eq('value->>value', email)
      .is('invalid_at', null)
      .limit(20_000);
    const dealIds = [...new Set((ownerClaims ?? []).map(r => (r as { entity_id: string }).entity_id))];
    const accounts = new Set<string>();
    for (let i = 0; i < dealIds.length; i += 200) {
      const { data: links } = await supabase.from('relationships')
        .select('from_entity_id, to_entity_id')
        .eq('workspace_id', workspaceId).eq('type', 'belongs_to')
        .in('from_entity_id', dealIds.slice(i, i + 200));
      for (const l of links ?? []) accounts.add((l as { to_entity_id: string }).to_entity_id);
      // A deal-shaped claim can sit on the account itself (a workspace with no deal entities).
      for (const id of dealIds.slice(i, i + 200)) if (!accounts.has(id)) accounts.add(id);
    }
    out.accounts += accounts.size;
    if (apply) {
      for (const accountId of accounts) {
        await attributeRelationship(supabase, workspaceId, accountId, userId, { label: 'crm_owner' }).catch(() => {});
      }
    }
  }
  return out;
}
