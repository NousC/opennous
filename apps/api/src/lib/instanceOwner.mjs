// Who may create a team of their own on a closed self-host instance (DISABLE_SIGNUPS=true).
//
// Nobody, except the one person who sets the instance up. On the bundled stack
// (docker-compose.selfhost.yaml) that person proves it with SELFHOST_SETUP_TOKEN, a
// one-time secret scripts/selfhost-keys.mjs writes into nous.env and db-schema prints in
// its log. The sign-up page sends it as Supabase user_metadata.nous_setup_token, so it
// reaches the API with whichever request provisions the account first.
//
// The claim is a single row in public.selfhost_instance_owner (id is a boolean primary
// key that can only be true, see deploy/selfhost/db/post-schema.sql). Two first sign-ups
// racing each other both pass the token check, but only one INSERT of that row succeeds;
// the other gets 23505 and is refused. "Count users, then insert" could not do that.
//
// Without SELFHOST_SETUP_TOKEN (an install against an external Supabase project that
// predates the bundled stack) the old rule stays: the first user on an empty instance is
// the owner. Cloud never sets DISABLE_SIGNUPS, so none of this runs there.

import { createHash, timingSafeEqual } from 'node:crypto';

export const OWNER_TABLE = 'selfhost_instance_owner';
export const SETUP_TOKEN_METADATA_KEY = 'nous_setup_token';

export function configuredSetupToken(env = process.env) {
  const t = String(env.SELFHOST_SETUP_TOKEN || '').trim();
  return t || null;
}

/** Constant-time compare of what the sign-up presented against the configured token. */
export function setupTokenMatches(presented, expected) {
  if (typeof presented !== 'string' || !presented.trim() || !expected) return false;
  const a = createHash('sha256').update(presented.trim()).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function refused(message) {
  const err = new Error(message);
  err.code = 'SIGNUPS_DISABLED';
  return err;
}

const CLOSED = 'Registration is disabled on this instance.';
const NEEDS_TOKEN = 'This instance has no owner yet. Create the first account with the setup link '
  + '(https://<your app domain>/signup?setup=<SELFHOST_SETUP_TOKEN>, printed by scripts/selfhost-keys.mjs '
  + 'and in `docker compose logs db-schema`).';

async function readClaim(supabase) {
  const { data, error } = await supabase.from(OWNER_TABLE).select('auth_user_id').eq('id', true).maybeSingle();
  if (error) throw new Error(`owner claim lookup failed: ${error.message}`);
  return data;
}

/**
 * Whether the instance owner has been claimed. With a setup token configured this reads
 * the claim row; without one, whether any user exists (the legacy rule). Errors resolve
 * to `fallback` so the sign-in page never locks the owner out on a transient failure.
 */
export async function ownerExists(supabase, { env = process.env, fallback = false } = {}) {
  try {
    if (configuredSetupToken(env)) return Boolean(await readClaim(supabase));
    const { count, error } = await supabase.from('users').select('id', { count: 'exact', head: true });
    if (error) return fallback;
    return (count ?? 0) > 0;
  } catch {
    return fallback;
  }
}

/**
 * DISABLE_SIGNUPS=true and a new identity with no invitation wants a team of its own.
 * Returns when it may (it is, or now atomically became, the instance owner); throws an
 * error with code SIGNUPS_DISABLED when it may not.
 *
 *   readPresentedToken  async () => the setup token this identity signed up with, or null.
 *                       Called only when there is no owner yet.
 *   afterClaim          async () => called once, right after this identity won the claim
 *                       (used to drop the token from the user's metadata). Best-effort.
 */
export async function assertMayCreateOwnTeam(supabase, authUserId, {
  env = process.env,
  readPresentedToken = async () => null,
  afterClaim = async () => {},
} = {}) {
  const expected = configuredSetupToken(env);

  if (!expected) {
    const { count } = await supabase.from('users').select('id', { count: 'exact', head: true });
    if ((count ?? 0) > 0) throw refused(CLOSED);
    return;
  }

  // Already claimed: only the owner themself gets through (a retry after the claim
  // succeeded but creating the team did not).
  const existing = await readClaim(supabase);
  if (existing) {
    if (existing.auth_user_id === authUserId) return;
    throw refused(CLOSED);
  }

  let presented = null;
  try { presented = await readPresentedToken(); } catch { presented = null; }
  if (!setupTokenMatches(presented, expected)) throw refused(NEEDS_TOKEN);

  const { error } = await supabase.from(OWNER_TABLE).insert({ id: true, auth_user_id: authUserId });
  if (error) {
    if (error.code === '23505') {
      const winner = await readClaim(supabase);
      if (winner?.auth_user_id === authUserId) return;
      throw refused(CLOSED);
    }
    throw new Error(`owner claim failed: ${error.message}`);
  }
  try { await afterClaim(); } catch { /* best-effort */ }
}
