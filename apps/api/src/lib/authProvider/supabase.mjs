// The Supabase Auth adapter for the auth-provider seam (./index.mjs). Self-host's
// auth: the same Supabase project that holds the database also signs the users
// in, so a self-hosted instance needs no third-party auth vendor.
//
// Token verification prefers a LOCAL check: Supabase access tokens are JWTs
// signed with the project's JWT secret (HS256), so with SUPABASE_JWT_SECRET set
// every request is verified with no network call. Without the secret, or for a
// project that signs with asymmetric keys, we fall back to asking Supabase
// (supabase.auth.getUser), which is what the pre-Clerk middleware always did.
//
// Admin operations (verify email, delete, magic link, create) go through the
// service-role client from @nous/core, i.e. supabase.auth.admin.

import { jwtVerify, errors as joseErrors } from 'jose';
import { getSupabaseClient } from '@nous/core';

export const name = 'supabase';
export const identityColumn = 'supabase_user_id';

// Supabase puts every signed-in user's token in this audience. The anon and
// service-role API keys are ALSO HS256 JWTs signed with the same secret, but with
// role anon / service_role and no `sub`; they must never authenticate as a user.
const USER_AUDIENCE = 'authenticated';

function secretKey(env = process.env) {
  const s = env.SUPABASE_JWT_SECRET;
  return s ? new TextEncoder().encode(s) : null;
}

function metaName(meta) {
  return meta?.full_name || meta?.name || null;
}

function metaAvatar(meta) {
  return meta?.avatar_url || meta?.picture || null;
}

// Reject anything that is a valid signature but not a real, signed-in user.
function assertUserClaims(payload) {
  if (!payload?.sub) throw new Error('invalid_token: no subject');
  if (payload.role && payload.role !== 'authenticated') throw new Error('invalid_token: not a user token');
  // Anonymous sign-ins (if a project enables them) carry role=authenticated but
  // have no email and no account to provision. Nous has no anonymous surface.
  if (payload.is_anonymous === true) throw new Error('invalid_token: anonymous session');
}

/**
 * Verify a Supabase access token locally with SUPABASE_JWT_SECRET (HS256).
 * Exported for tests. Throws on a bad signature, an expired token, a wrong
 * audience, or a non-user token. Returns the normalized identity.
 */
export async function verifyTokenLocally(token, env = process.env) {
  const key = secretKey(env);
  if (!key) throw new Error('SUPABASE_JWT_SECRET is not set');
  const { payload } = await jwtVerify(token, key, {
    algorithms: ['HS256'],
    audience: USER_AUDIENCE,
  });
  assertUserClaims(payload);
  const meta = payload.user_metadata || {};
  return {
    authUserId: payload.sub,
    email: payload.email || null,
    // The access token does not carry email_confirmed_at. Supabase sets
    // user_metadata.email_verified on email signups once confirmed; treat its
    // absence as "unknown" and let isEmailVerified() ask when it matters.
    emailVerified: meta.email_verified === true ? true : null,
    name: metaName(meta),
    avatarUrl: metaAvatar(meta),
    claims: payload,
  };
}

// The network path: Supabase validates the token and returns the user.
async function verifyTokenRemotely(token) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new Error(`invalid_token: ${error?.message || 'no user'}`);
  const user = data.user;
  if (user.is_anonymous === true) throw new Error('invalid_token: anonymous session');
  const meta = user.user_metadata || {};
  return {
    authUserId: user.id,
    email: user.email || null,
    emailVerified: Boolean(user.email_confirmed_at),
    name: metaName(meta),
    avatarUrl: metaAvatar(meta),
    claims: { sub: user.id, email: user.email, user_metadata: meta },
    user,
  };
}

export async function verifyToken(token) {
  if (secretKey()) {
    try {
      return await verifyTokenLocally(token);
    } catch (err) {
      // A project on the newer asymmetric signing keys (ES256/RS256) issues
      // tokens the shared secret can't check. That is not a forgery, it's a
      // config mismatch: ask Supabase instead of locking everyone out.
      // Every other failure (bad signature, expired, wrong audience) is final.
      // TODO(GET-577): verify asymmetric tokens locally against the project JWKS
      // (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`) instead of the network fallback.
      if (err instanceof joseErrors.JOSEAlgNotAllowed) return verifyTokenRemotely(token);
      throw err;
    }
  }
  return verifyTokenRemotely(token);
}

export async function getProfile(verified) {
  let { email, name: displayName, avatarUrl } = verified;
  if (!email) {
    // Only reached for a token with no email claim (e.g. a phone-only user).
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.admin.getUserById(verified.authUserId);
    if (error) throw error;
    const meta = data?.user?.user_metadata || {};
    email = data?.user?.email || null;
    displayName = displayName || metaName(meta);
    avatarUrl = avatarUrl || metaAvatar(meta);
  }
  return { email, name: displayName, avatarUrl };
}

/**
 * Whether this Supabase Auth user proved they own `email`. Pure (exported for tests).
 *
 * email_confirmed_at alone is not proof. With GOTRUE_MAILER_AUTOCONFIRM (the bundled
 * stack without SMTP, or a project with "Confirm email" off) GoTrue stamps it at sign-up
 * for whatever address was typed, and the stamp stays when the operator later adds SMTP
 * and turns autoconfirm off. So a squatter who signed up as ceo@corp.com back then would
 * look verified from that moment on. Proof is one of:
 *   - a confirmation (or invite) email that was sent and then followed: GoTrue sets
 *     confirmation_sent_at / invited_at when it sends one, and an autoconfirmed sign-up
 *     never has either;
 *   - an OAuth identity (Google, GitHub, ...) whose provider says the address is verified;
 *   - an account the operator created with the address marked confirmed
 *     (findOrCreateUserByEmail sets app_metadata.nous_email_vouched; app_metadata is not
 *     writable by the user).
 */
export function emailProvenByRoundTrip(user, email) {
  if (!user?.email || !email) return false;
  const want = String(email).toLowerCase();
  if (user.email.toLowerCase() !== want) return false;
  if (!user.email_confirmed_at) return false;
  if (user.app_metadata?.nous_email_vouched === true) return true;
  const confirmedAt = Date.parse(user.email_confirmed_at);
  const sentBefore = (ts) => Boolean(ts) && Number.isFinite(Date.parse(ts)) && Date.parse(ts) <= confirmedAt;
  if (sentBefore(user.confirmation_sent_at) || sentBefore(user.invited_at)) return true;
  return (user.identities || []).some((i) => i?.provider && i.provider !== 'email'
    && i.identity_data?.email_verified === true
    && String(i.identity_data?.email || '').toLowerCase() === want);
}

/**
 * Whether the Supabase user's email is proven (see emailProvenByRoundTrip) AND is the
 * given address. Throws on infra errors so callers can choose fail-open vs fail-closed.
 */
export async function isEmailVerified(authUserId, email) {
  if (!authUserId || !email) return false;
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.admin.getUserById(authUserId);
  if (error) {
    // A user that doesn't exist is a definitive "no", not an outage.
    if (error.status === 404) return false;
    throw error;
  }
  return emailProvenByRoundTrip(data?.user, email);
}

/** The user's user_metadata (what they sent at sign-up, editable by them). Throws on errors. */
export async function getUserMetadata(authUserId) {
  if (!authUserId) return {};
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.admin.getUserById(authUserId);
  if (error) throw error;
  return data?.user?.user_metadata || {};
}

/** Remove keys from the user's user_metadata (best-effort cleanup; throws on errors). */
export async function clearUserMetadataKeys(authUserId, keys) {
  const supabase = getSupabaseClient();
  const patch = Object.fromEntries(keys.map((k) => [k, null]));
  const { error } = await supabase.auth.admin.updateUserById(authUserId, { user_metadata: patch });
  if (error) throw error;
}

export async function deleteUser(authUserId) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.auth.admin.deleteUser(authUserId);
  if (error) throw error;
}

/**
 * A one-time magic link that signs the user in (admin impersonation, agency
 * claim links). Supabase controls the link's lifetime (Auth → Email OTP
 * expiry), so expiresInSeconds is advisory here. The link lands on
 * `${appUrl}/login`, where the Supabase client picks the session out of the URL.
 */
export async function createSignInLink({ email, appUrl }) {
  if (!email) return null;
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo: `${appUrl}/login` },
  });
  if (error) throw error;
  return data?.properties?.action_link || null;
}

/**
 * Reuse the Supabase auth user for this email, or create one with no password
 * and the email marked confirmed (an operator vouches for it, as Clerk's
 * createUser does). Used by Partner OS provisioning.
 */
export async function findOrCreateUserByEmail({ email, name: displayName }) {
  const supabase = getSupabaseClient();
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    // The operator vouches for this address (see emailProvenByRoundTrip).
    app_metadata: { nous_email_vouched: true },
    user_metadata: displayName ? { name: displayName, full_name: displayName } : {},
  });
  if (!createErr && created?.user?.id) return { authUserId: created.user.id };

  // Already registered: find the existing auth user. The admin API has no
  // lookup-by-email, so page through users (bounded; a self-host has few).
  const target = String(email).toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = data?.users || [];
    const hit = users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return { authUserId: hit.id };
    if (users.length < 1000) break;
  }
  throw createErr || new Error('auth_user_not_found');
}
