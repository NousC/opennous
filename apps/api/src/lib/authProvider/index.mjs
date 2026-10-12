// The auth provider seam (GET-577).
//
// Nous Cloud authenticates with Clerk. A self-hosted instance authenticates with
// plain Supabase Auth, so an operator needs nothing beyond the Supabase project
// they already run the database on. Everything outside this folder talks to the
// provider through the functions below and never imports a provider SDK itself:
// `cloud/lib/authProvider/clerk.mjs` is the ONLY file in the API that imports
// `@clerk/backend`, and this file only reaches it through the cloud loader
// (lib/cloud.mjs), so the open-source export, which has no src/cloud/, still boots
// on the supabase path.
//
// Selection: AUTH_PROVIDER=clerk|supabase. Unset, it follows the deployment:
// SELF_HOSTED=true → supabase, anything else → clerk (Cloud stays on Clerk with
// no new env var).
//
// The provider contract (both adapters export these):
//   name                              'clerk' | 'supabase'
//   identityColumn                    the users column that holds the provider's user id
//   verifyToken(token)                → { authUserId, email, emailVerified, name, avatarUrl, claims }
//                                       throws on an invalid / expired token.
//                                       emailVerified is true/false when the token says, null when unknown.
//   getProfile(verified)              → { email, name, avatarUrl } (may make one network call)
//   isEmailVerified(authUserId, email) → boolean; THROWS on infra errors (callers choose open/closed)
//   deleteUser(authUserId)            → void; throws on failure
//   createSignInLink({ authUserId, email, appUrl, expiresInSeconds }) → url string | null
//   findOrCreateUserByEmail({ email, name }) → { authUserId }

import { HAS_CLOUD, loadCloud } from '../cloud.mjs';

const PROVIDERS = new Set(['clerk', 'supabase']);

/** Which provider this process uses. Pure: reads only the env passed in (and whether this build has src/cloud/). */
export function resolveAuthProviderName(env = process.env) {
  const explicit = String(env.AUTH_PROVIDER || '').trim().toLowerCase();
  if (explicit) {
    if (PROVIDERS.has(explicit)) return explicit;
    // A typo must not silently pick a provider. Fall through to the deployment
    // default, loudly, rather than throw at import time and take the API down.
    console.warn(`[authProvider] AUTH_PROVIDER="${env.AUTH_PROVIDER}" is not one of clerk|supabase — using the default.`);
  }
  // An open-source build (no src/cloud/, GET-754) has no Clerk: always Supabase.
  return env.SELF_HOSTED === 'true' || !HAS_CLOUD ? 'supabase' : 'clerk';
}

export function authProviderName() {
  return resolveAuthProviderName(process.env);
}

const IDENTITY_COLUMNS = { clerk: 'clerk_user_id', supabase: 'supabase_user_id' };

/**
 * The public.users column that stores the auth provider's user id. Cloud keeps
 * `clerk_user_id`; self-host uses `supabase_user_id`, which is already in
 * supabase/schema.sql (the fresh-install path). Columns are never renamed.
 */
export function identityColumn(name = authProviderName()) {
  return IDENTITY_COLUMNS[name] || IDENTITY_COLUMNS.clerk;
}

// One module per provider, loaded on first use and reused. Keyed by name so a
// test that flips AUTH_PROVIDER gets the right adapter.
const loaded = new Map();

export function getAuthProvider(name = authProviderName()) {
  if (!loaded.has(name)) {
    // Clerk is Cloud's (src/cloud/lib/authProvider/clerk.mjs), reached only through the cloud
    // loader so an open-source build, which has no cloud/, still links (GET-754).
    const p = name === 'supabase'
      ? import('./supabase.mjs')
      : loadCloud().then((cloud) => {
        const load = cloud?.authProviders?.[name];
        if (!load) throw new Error(`auth provider "${name}" is part of the Workspace (Cloud) layer, which this build does not include. Use AUTH_PROVIDER=supabase.`);
        return load();
      });
    // Don't cache a failed import (e.g. a missing optional dependency) forever.
    p.catch(() => loaded.delete(name));
    loaded.set(name, p);
  }
  return loaded.get(name);
}

/**
 * Whether we may bind this auth identity onto an existing internal user matched
 * by email. Fails OPEN on infrastructure errors (provider down / rate-limited) so
 * a transient outage can't dump a legitimate user into a fresh empty workspace;
 * fails CLOSED only on a definitive "unverified" answer (the account-takeover
 * case: signing up as victim@corp.com with an unverified address must never
 * inherit the victim's team). Both auth paths (middleware/supabaseAuth.mjs and
 * lib/auth.mjs) use this so they agree on identity.
 */
export async function canBindEmailIdentity(authUserId, email) {
  // With autoconfirm, "confirmed" proves nothing (see emailConfirmedWithoutRoundTrip),
  // and a stranger could sign up as the address on an imported row and inherit it.
  if (emailConfirmedWithoutRoundTrip()) return false;
  const provider = await getAuthProvider();
  try {
    return await provider.isEmailVerified(authUserId, email);
  } catch (err) {
    console.warn(`[authProvider:${provider.name}] email-verify check errored — failing open (bind allowed):`, err?.message);
    return true;
  }
}

/**
 * Whether a signed-in identity may be auto-joined to a team by an invitation
 * addressed to its email. On Clerk this is always true, exactly as before GET-577
 * (Clerk verifies the address at signup), so Cloud is unchanged. Supabase issues a
 * session for an unconfirmed address when the project has "Confirm email" off,
 * so there we require email_confirmed_at, and fail CLOSED on errors: the user can
 * simply retry, whereas a wrong "yes" hands a stranger the team.
 */
export async function canJoinByInvitedEmail(authUserId, email) {
  if (authProviderName() !== 'supabase') return true;
  if (!authUserId || !email) return false;
  try {
    const provider = await getAuthProvider('supabase');
    return await provider.isEmailVerified(authUserId, email);
  } catch {
    return false;
  }
}

/**
 * True when Supabase Auth marks every address confirmed at sign-up without sending
 * an email (GoTrue's GOTRUE_MAILER_AUTOCONFIRM, the bundled stack's default when no
 * SMTP is set). Then email_confirmed_at is stamped for whatever address someone
 * typed, so it is no evidence they own it. The bundled compose passes the same
 * value to the API as AUTH_EMAIL_AUTOCONFIRM. Never true on Clerk.
 */
export function emailConfirmedWithoutRoundTrip(env = process.env) {
  if (resolveAuthProviderName(env) !== 'supabase') return false;
  return String(env.AUTH_EMAIL_AUTOCONFIRM || '').trim().toLowerCase() === 'true';
}

/**
 * Whether something addressed to an email (a pending team invitation, a pending
 * seat) may be handed to a signed-in identity on the strength of the email alone,
 * with no invite token. Clerk: always, as before (Cloud unchanged). Supabase: only
 * when the address was confirmed by an actual email round-trip, so never under
 * autoconfirm; there an invitee joins by accepting the invite link, whose token is
 * the proof (POST /api/invitations/:token/accept).
 */
export async function canClaimByEmailMatch(authUserId, email) {
  if (authProviderName() !== 'supabase') return true;
  if (emailConfirmedWithoutRoundTrip()) return false;
  return canJoinByInvitedEmail(authUserId, email);
}

/**
 * Find the internal users row for an auth identity. `supabase` is passed in (not
 * imported) so this stays a pure query helper that tests can drive with a fake.
 * Returns { data, error } like a Supabase call.
 */
export async function findUserByAuthId(supabase, authUserId, select = 'id', name = authProviderName()) {
  if (!authUserId) return { data: null, error: null };
  return supabase
    .from('users')
    .select(select)
    .eq(identityColumn(name), authUserId)
    .maybeSingle();
}
