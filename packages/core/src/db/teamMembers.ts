import type { SupabaseClient } from '@supabase/supabase-js';
import { getOrCreateEntity } from './entities.js';
import { assertClaims } from './claims.js';

// Team members are the humans seated on the workspace — the operators, not the
// market. A person who is on your team must never be treated as a prospect: no
// ICP score, no lead list, no outreach. But they still get a fully resolved
// record (their meeting notes, their activity) like any other account.
//
// The signal of truth is the workspace itself. Anyone whose login email is a
// workspace member is internal. We recognise this automatically — flip a matching
// account to internal — rather than asking anyone to tag people by hand.
//
// "internal" is stored as an asserted claim (`is_internal = true`) on the person
// entity. Asserted claims are sticky: the derivation engine never overwrites them
// (see recomputeClaim), so the flag survives every re-derivation. This mirrors the
// buying_role precedent — a declared fact that wins over inference.

export const IS_INTERNAL = 'is_internal';
// Which workspace member this internal entity IS (the member's user id). Lets us
// answer "this internal account = teammate X" and is the seed for attribution.
export const TEAM_USER_ID = 'team_user_id';

/** An identity (email or LinkedIn) that belongs to a team member. */
export interface InternalIdentity {
  ownerUserId: string;
  kind: 'email' | 'linkedin_url';
  value: string;
  label: string | null;   // the member's name, for display
}

/** Every seated member's login email on this workspace, normalised to lowercase. */
export async function getWorkspaceMemberEmails(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('workspace_members')
    .select('users:user_id(email)')
    .eq('workspace_id', workspaceId);
  if (error) throw new Error(`failed to load workspace members: ${error.message}`);

  const emails = new Set<string>();
  for (const row of (data as { users?: { email?: string | null } | { email?: string | null }[] } []) ?? []) {
    // PostgREST returns the joined row as an object (to-one) but can type it as
    // an array — normalise both shapes.
    const users = Array.isArray(row.users) ? row.users : row.users ? [row.users] : [];
    for (const u of users) {
      const email = u?.email?.trim().toLowerCase();
      if (email) emails.add(email);
    }
  }
  return [...emails];
}

/**
 * Every identity that belongs to a team member: their login email, the address
 * of any mailbox they connected (Gmail/SMTP), and any LinkedIn account they own.
 * Each identity carries the member's user id so a touch through it can later be
 * attributed to the right rep. This is the full "internal identity set", a
 * superset of getWorkspaceMemberEmails (login only).
 */
export async function getInternalIdentities(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<InternalIdentity[]> {
  const [members, mailboxes, linkedins] = await Promise.all([
    supabase.from('workspace_members').select('user_id, users:user_id(email, name)').eq('workspace_id', workspaceId),
    supabase.from('workflow_provider_connections').select('owner_user_id, account_email').eq('workspace_id', workspaceId),
    supabase.from('workspace_linkedin_connections').select('owner_user_id, linkedin_profile_url, linkedin_name, label').eq('workspace_id', workspaceId),
  ]);

  const out: InternalIdentity[] = [];
  const seen = new Set<string>(); // dedupe on kind+value

  const add = (ownerUserId: string | null | undefined, kind: 'email' | 'linkedin_url', raw: string | null | undefined, label: string | null) => {
    if (!ownerUserId || !raw) return;
    const value = kind === 'email' ? raw.trim().toLowerCase() : raw.trim();
    if (!value) return;
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ownerUserId, kind, value, label });
  };

  for (const row of (members.data as { user_id: string; users?: { email?: string; name?: string } | { email?: string; name?: string }[] }[]) ?? []) {
    const u = Array.isArray(row.users) ? row.users[0] : row.users;
    add(row.user_id, 'email', u?.email, u?.name ?? null);
  }
  for (const row of (mailboxes.data as { owner_user_id?: string; account_email?: string }[]) ?? []) {
    add(row.owner_user_id, 'email', row.account_email, null);
  }
  for (const row of (linkedins.data as { owner_user_id?: string; linkedin_profile_url?: string; linkedin_name?: string; label?: string }[]) ?? []) {
    add(row.owner_user_id, 'linkedin_url', row.linkedin_profile_url, row.label ?? row.linkedin_name ?? null);
  }
  return out;
}

/** Every internal EMAIL address on the workspace (logins + connected mailboxes),
 *  lowercased. Use this to decide if an incoming address is one of ours. */
export async function getInternalEmails(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<string[]> {
  const ids = await getInternalIdentities(supabase, workspaceId);
  return ids.filter(i => i.kind === 'email').map(i => i.value);
}

/** True if this email is one of ours — a member login OR a connected mailbox. */
export async function isEmailInternal(
  supabase: SupabaseClient,
  workspaceId: string,
  email: string | null | undefined,
): Promise<boolean> {
  const target = email?.trim().toLowerCase();
  if (!target) return false;
  const emails = await getInternalEmails(supabase, workspaceId);
  return emails.includes(target);
}

/** Resolve a connected mailbox address to the member who owns it, or null. */
export async function connectedAccountOwnerByEmail(
  supabase: SupabaseClient,
  workspaceId: string,
  email: string | null | undefined,
): Promise<string | null> {
  const target = email?.trim().toLowerCase();
  if (!target) return null;
  const ids = await getInternalIdentities(supabase, workspaceId);
  return ids.find(i => i.kind === 'email' && i.value === target)?.ownerUserId ?? null;
}

/** Resolve a connected LinkedIn account to the member who owns it, or null. */
export async function connectedLinkedinOwner(
  supabase: SupabaseClient,
  workspaceId: string,
  unipileAccountId: string | null | undefined,
): Promise<string | null> {
  if (!unipileAccountId) return null;
  const { data } = await supabase
    .from('workspace_linkedin_connections')
    .select('owner_user_id')
    .eq('workspace_id', workspaceId)
    .eq('unipile_account_id', unipileAccountId)
    .maybeSingle();
  return (data as { owner_user_id?: string } | null)?.owner_user_id ?? null;
}

/** Mark a person entity as internal (an asserted is_internal=true claim), and
 *  optionally record which member it is. Idempotent. */
export async function markEntityInternal(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  teamUserId?: string | null,
): Promise<void> {
  const values: Record<string, unknown> = { [IS_INTERNAL]: true };
  if (teamUserId) values[TEAM_USER_ID] = teamUserId;
  await assertClaims(supabase, workspaceId, entityId, {
    values,
    source: 'team_recognition',
  });
}

/** The entity ids on this workspace currently flagged internal. Used to exclude
 *  team members from scoring, lead lists, and outreach. */
export async function getInternalEntityIds(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('claims')
    .select('entity_id, value')
    .eq('workspace_id', workspaceId)
    .eq('property', IS_INTERNAL)
    .is('invalid_at', null);
  if (error) throw new Error(`failed to load internal entities: ${error.message}`);
  const ids = new Set<string>();
  for (const row of (data as { entity_id: string; value: unknown }[]) ?? []) {
    if (row.value === true) ids.add(row.entity_id);
  }
  return ids;
}

/** True if this single entity is flagged internal. */
export async function isEntityInternal(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('claims')
    .select('value')
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .eq('property', IS_INTERNAL)
    .is('invalid_at', null)
    .maybeSingle();
  return (data as { value?: unknown } | null)?.value === true;
}

/**
 * Recognise every team member on this workspace and flag their account as
 * internal. For each member login email we get-or-create the person entity and
 * assert is_internal on it.
 *
 * We CREATE the entity (rather than only flagging pre-existing ones) so a
 * teammate always has a resolved record the moment they are on the workspace.
 * That record is what an internal meeting attaches to (meeting ingestion only
 * resolves contacts that already exist) and what the desktop AIOS pulls internal
 * notes from. The entity is flagged internal, so it is excluded from every GTM
 * surface (scoring, lead lists, outreach) regardless.
 *
 * Idempotent and cheap (workspaces have few members), so it is safe to call at
 * the front of any GTM action and on member-invite as a guard. It also serves as
 * the backfill: the first run flags everyone already in the graph. Returns the
 * number of members recognised this run.
 */
export async function recogniseTeamMembers(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<number> {
  const identities = await getInternalIdentities(supabase, workspaceId);
  const seenEntities = new Set<string>();
  for (const id of identities) {
    // Each identity (login email, connected mailbox, owned LinkedIn) resolves or
    // creates a person entity; flag it internal and stamp the member it belongs
    // to. Resolving per-identity (rather than one entity per member) means a
    // teammate's alias that landed as its own account still gets flagged, even
    // before any entity-merge.
    const entityId = await getOrCreateEntity(supabase, workspaceId, 'person', [
      { kind: id.kind, value: id.value },
    ]);
    await markEntityInternal(supabase, workspaceId, entityId, id.ownerUserId);
    seenEntities.add(entityId);
  }
  return seenEntities.size;
}
