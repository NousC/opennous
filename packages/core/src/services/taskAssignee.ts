// Who owes a task — resolved late, so onboarding a person hands them their history.
//
// The obvious design is to stamp a `user_id` on a task when it is created. It does not work here,
// and the reason is worth stating because it is a property of the product rather than a gap.
//
// The people who make commitments are usually not users of the product yet. Measured on a customer workspace:
// the workspace has a handful of members, while its calls are run by Wren, Calder, Juno,
// Tamsin, Odessa, Bastian and Lyra — over a dozen distinct host addresses across a hundred-odd
// meetings, none of them a seat. A task created today cannot name a seat that will not exist until someone is
// onboarded next month. `loadOurSide` already has this limitation baked in: it resolves our side
// only against workspace members, so it returns null for every one of those calls.
//
// So the task stores the NATURAL KEY — the email of whoever made the commitment, which every
// source already knows — and the seat is resolved on read. Onboard wren@harborline.example and every
// task she ever promised becomes hers, retroactively, with no backfill. Before that, her name
// still shows; "Wren owes this" is useful even when Wren cannot log in.
//
// This is the same shape as workspace_own_domains and pending_seats: identity observed now, bound
// to an account later. Storing a foreign key that cannot yet exist is what forces a backfill.

import type { SupabaseClient } from '@supabase/supabase-js';

export interface TaskOwner {
  /** The email on the commitment, lowercased. The durable key. */
  email: string | null;
  /** Display name, for when no seat exists yet. */
  name: string | null;
  /** The seat, when one exists for that email TODAY. Null is normal, not a failure. */
  userId: string | null;
}

/** Normalise an address for matching. Addresses arrive from calendars, mail headers and transcripts. */
export const normaliseOwnerEmail = (raw: unknown): string | null => {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  // "Wren Okonkwo <wren@harborline.example>" → wren@harborline.example
  const angled = /<([^>]+)>/.exec(s);
  const addr = (angled ? angled[1] : s).trim();
  return addr.includes('@') ? addr : null;
};

/**
 * Map owner emails to seats, for a whole batch of tasks at once.
 *
 * Returns a lookup rather than resolving one at a time, because the caller is rendering a list and
 * a per-row query is how a task list becomes slow enough that nobody opens it — which is the
 * failure GET-384 was already about.
 */
export async function seatsByEmail(
  supabase: SupabaseClient,
  workspaceId: string,
  emails: (string | null | undefined)[],
): Promise<Map<string, { userId: string; name: string | null }>> {
  const wanted = [...new Set(emails.map(normaliseOwnerEmail).filter((e): e is string => !!e))];
  const out = new Map<string, { userId: string; name: string | null }>();
  if (!wanted.length) return out;

  const { data, error } = await supabase
    .from('workspace_members')
    .select('user_id, users(email, name)')
    .eq('workspace_id', workspaceId);
  if (error || !data) return out;

  for (const row of data as unknown as { user_id: string; users: { email: string | null; name: string | null } | null }[]) {
    const email = normaliseOwnerEmail(row.users?.email);
    if (email && wanted.includes(email)) {
      out.set(email, { userId: row.user_id, name: row.users?.name ?? null });
    }
  }
  return out;
}

/**
 * The owner of one task, given the batch lookup.
 *
 * `owner_kind` still decides WHOSE side it is — 'prospect' means the customer owes it, and no seat
 * of ours should ever be named on those. Filing a customer's promise against one of our people is
 * worse than showing nobody: it puts a nag on a rep for work that was never theirs.
 */
export function ownerOfTask(
  value: Record<string, unknown> | null | undefined,
  seats: Map<string, { userId: string; name: string | null }>,
): TaskOwner {
  const v = value ?? {};
  if (v.owner_kind === 'prospect') {
    return { email: null, name: (v.owner_name as string) ?? null, userId: null };
  }
  const email = normaliseOwnerEmail(v.owner_email);
  const seat = email ? seats.get(email) : undefined;
  return {
    email,
    // The seat's name wins once it exists — it is the name the team actually uses.
    name: seat?.name ?? (v.owner_name as string) ?? null,
    userId: seat?.userId ?? null,
  };
}
