import type { SupabaseClient } from '@supabase/supabase-js';
import { getClaim, assertClaims } from './claims.js';
import { getInternalIdentities, getInternalEntityIds } from './teamMembers.js';

// Which team member an account's relationship belongs to. Not a single owner —
// multiple reps can be in touch with the same contact, and seeing that is the
// point (it's the agency anti-collision signal: "you and Akash are both on
// Acme"). So we track everyone in touch in `members`, and derive a `primary`.
//
// Stored as one asserted `relationship_owner` claim on the account entity, value:
//   { primary: <user_id>, members: [{ user_id, label, last_touch, touches }] }
//
// `primary` = whoever engaged most recently (the rep actively on it). Updated at
// ingestion: each attributed touch refreshes that member's row and recomputes
// the primary. Internal accounts (teammates themselves) are never attributed.

export const RELATIONSHIP_OWNER = 'relationship_owner';

export interface RelationshipMember {
  user_id: string;
  label: string | null;
  last_touch: string;   // ISO
  touches: number;
}

export interface RelationshipOwner {
  primary: string;
  members: RelationshipMember[];
}

/**
 * Record that a team member touched an account, and refresh the account's
 * relationship_owner claim. Adds the member to `members` (or bumps their touch
 * count + last_touch), then sets `primary` to whoever touched most recently.
 * Idempotent in shape — call it on every attributable interaction.
 */
export async function attributeRelationship(
  supabase: SupabaseClient,
  workspaceId: string,
  accountEntityId: string,
  ownerUserId: string,
  opts: { at?: string; label?: string | null } = {},
): Promise<void> {
  if (!ownerUserId) return;
  const at = opts.at ?? new Date().toISOString();

  const existing = await getClaim(supabase, workspaceId, accountEntityId, RELATIONSHIP_OWNER);
  const current = (existing?.value as RelationshipOwner | undefined) ?? { primary: ownerUserId, members: [] };
  const members = Array.isArray(current.members) ? [...current.members] : [];

  const idx = members.findIndex(m => m.user_id === ownerUserId);
  if (idx === -1) {
    members.push({ user_id: ownerUserId, label: opts.label ?? null, last_touch: at, touches: 1 });
  } else {
    const m = members[idx];
    members[idx] = {
      user_id: ownerUserId,
      label: opts.label ?? m.label ?? null,
      last_touch: at > m.last_touch ? at : m.last_touch,
      touches: m.touches + 1,
    };
  }

  // Primary = most recent toucher (the rep actively on the relationship).
  const primary = members.reduce((a, b) => (b.last_touch > a.last_touch ? b : a)).user_id;

  await assertClaims(supabase, workspaceId, accountEntityId, {
    values: { [RELATIONSHIP_OWNER]: { primary, members } },
    source: 'attribution',
  });
}

/** The relationship_owner claim for many accounts at once, keyed by entity id.
 *  For a list view that needs to show who's on each account without N queries. */
export async function getRelationshipOwners(
  supabase: SupabaseClient,
  workspaceId: string,
  entityIds: string[],
): Promise<Map<string, RelationshipOwner>> {
  const out = new Map<string, RelationshipOwner>();
  if (!entityIds.length) return out;

  const { data } = await supabase
    .from('claims')
    .select('entity_id, value')
    .eq('workspace_id', workspaceId)
    .eq('property', RELATIONSHIP_OWNER)
    .is('invalid_at', null)
    .in('entity_id', entityIds);

  for (const row of (data ?? []) as { entity_id: string; value: RelationshipOwner | null }[]) {
    if (row.value?.primary) out.set(row.entity_id, row.value);
  }
  return out;
}

/** user_id → display name, for everyone in the workspace. The owner of an account
 *  is a person, and a UUID is not a person. */
export async function getWorkspaceMemberNames(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { data: members } = await supabase
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId);
  const ids = (members ?? []).map((m: { user_id: string }) => m.user_id);
  if (!ids.length) return out;

  const { data: users } = await supabase
    .from('users')
    .select('id, name, email')
    .in('id', ids);
  for (const u of (users ?? []) as { id: string; name: string | null; email: string | null }[]) {
    out.set(u.id, u.name || u.email || 'Unknown');
  }
  return out;
}

/**
 * Every account this member is IN TOUCH with — i.e. they appear in the account's
 * relationship_owner.members list, because they have actually emailed or messaged
 * this person themselves.
 *
 * This is the account-level privacy key (PRIVACY_MODEL.md). If you're in touch
 * with an account, you can read everything on it — including a teammate's messages
 * to the same person — because it's YOUR relationship too and you'd be flying
 * blind without their half of the conversation.
 *
 * Deliberately `members` and not `primary`. `primary` is whoever touched most
 * recently, so it flips every time a teammate replies — and visibility that flips
 * under you is worse than either rule on its own. Membership only ever grows.
 */
export async function inTouchEntityIds(
  supabase: SupabaseClient,
  workspaceId: string,
  viewerUserId: string | null | undefined,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!viewerUserId) return out;

  const { data } = await supabase
    .from('claims')
    .select('entity_id, value')
    .eq('workspace_id', workspaceId)
    .eq('property', RELATIONSHIP_OWNER)
    .is('invalid_at', null);

  for (const row of (data ?? []) as { entity_id: string; value: RelationshipOwner | null }[]) {
    const v = row.value;
    if (!v) continue;
    const members = Array.isArray(v.members) ? v.members : [];
    if (v.primary === viewerUserId || members.some(m => m.user_id === viewerUserId)) {
      out.add(row.entity_id);
    }
  }
  return out;
}

/** Whether this viewer is in touch with ONE account — the single-entity form of
 *  `inTouchEntityIds`, for a page that only ever renders one record. */
export async function isInTouchWith(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  viewerUserId: string | null | undefined,
): Promise<boolean> {
  if (!viewerUserId) return false;
  const claim = await getClaim(supabase, workspaceId, entityId, RELATIONSHIP_OWNER);
  const v = claim?.value as RelationshipOwner | undefined;
  if (!v) return false;
  const members = Array.isArray(v.members) ? v.members : [];
  return v.primary === viewerUserId || members.some(m => m.user_id === viewerUserId);
}

/** Pull a bare email out of a "Name <email>" or plain-email string. */
function extractEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

/**
 * One-time backfill: reconstruct relationship_owner for every external account
 * from its existing email history. Each email observation's raw.from (sent) /
 * raw.to (received) records the connected mailbox, so we map each touch to the
 * owning rep — accurate even across multiple mailboxes. Going-forward attribution
 * (the ingestion handlers) does the same per touch; this seeds the back-history.
 *
 * Safe + non-destructive: only writes accounts that have NO relationship_owner
 * yet, so it never clobbers attribution from other channels (LinkedIn, meetings)
 * or from the live handlers. Idempotent — re-running skips already-attributed
 * accounts. Pure PostgREST (no DDL), so it can run from any client with the
 * workspace's service key.
 */
export async function backfillEmailAttribution(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<{ scanned: number; attributed: number; skipped: number }> {
  const identities = await getInternalIdentities(supabase, workspaceId);
  const emailToOwner = new Map<string, { ownerUserId: string; label: string | null }>();
  for (const i of identities) {
    if (i.kind === 'email') emailToOwner.set(i.value, { ownerUserId: i.ownerUserId, label: i.label });
  }
  const internal = await getInternalEntityIds(supabase, workspaceId);

  const { data, error } = await supabase
    .from('observations')
    .select('entity_id, property, observed_at, raw')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'event')
    .in('property', ['interaction.email_sent', 'interaction.email_received']);
  if (error) throw new Error(`backfill: failed to read observations: ${error.message}`);

  // entity -> ownerUserId -> { label, touches, last_touch }
  const perEntity = new Map<string, Map<string, { label: string | null; touches: number; last_touch: string }>>();

  for (const row of (data as { entity_id: string; property: string; observed_at: string; raw: unknown }[]) ?? []) {
    if (internal.has(row.entity_id)) continue;
    const raw = (row.raw ?? {}) as { from?: unknown; to?: unknown };

    // Find the mailbox address: the sender for outbound, or whichever recipient
    // is one of ours for inbound.
    let owner: { ownerUserId: string; label: string | null } | undefined;
    if (row.property === 'interaction.email_sent') {
      const from = extractEmail(raw.from);
      if (from) owner = emailToOwner.get(from);
    } else {
      const tos = Array.isArray(raw.to) ? raw.to : [raw.to];
      for (const t of tos) {
        const addr = extractEmail(t);
        if (addr && emailToOwner.has(addr)) { owner = emailToOwner.get(addr); break; }
      }
    }
    if (!owner) continue;

    let byOwner = perEntity.get(row.entity_id);
    if (!byOwner) { byOwner = new Map(); perEntity.set(row.entity_id, byOwner); }
    const cur = byOwner.get(owner.ownerUserId);
    const at = row.observed_at ?? new Date(0).toISOString();
    if (!cur) byOwner.set(owner.ownerUserId, { label: owner.label, touches: 1, last_touch: at });
    else { cur.touches += 1; if (at > cur.last_touch) cur.last_touch = at; }
  }

  let attributed = 0, skipped = 0;
  for (const [entityId, byOwner] of perEntity) {
    // Don't clobber an account that already has a relationship_owner (live
    // attribution or another channel got there first).
    const existing = await getClaim(supabase, workspaceId, entityId, RELATIONSHIP_OWNER);
    if (existing) { skipped++; continue; }

    const members: RelationshipMember[] = [...byOwner.entries()].map(([user_id, m]) => ({
      user_id, label: m.label, last_touch: m.last_touch, touches: m.touches,
    }));
    const primary = members.reduce((a, b) => (b.last_touch > a.last_touch ? b : a)).user_id;
    await assertClaims(supabase, workspaceId, entityId, {
      values: { [RELATIONSHIP_OWNER]: { primary, members } },
      source: 'attribution_backfill',
    });
    attributed++;
  }

  return { scanned: perEntity.size, attributed, skipped };
}
