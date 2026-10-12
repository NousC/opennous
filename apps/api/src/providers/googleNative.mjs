/**
 * Native Google OAuth for self-hosted installs (GET-765).
 *
 * Cloud connects Gmail and Google Calendar through Composio (providers/composio.mjs). A
 * self-hoster can instead register their own Google OAuth app and set GOOGLE_CLIENT_ID,
 * GOOGLE_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI. Then the member signs in with Google
 * directly, the tokens are stored encrypted on the connection row (ENCRYPTION_KEY, the same
 * encryptValue every other credential uses), and the worker reads Google with them through the
 * same scans Composio connections use (apps/worker/src/utils/googleNative.mjs).
 *
 * Which one a workspace gets (connectMode):
 *   - Cloud build (src/cloud present)             → composio, always. Cloud does not change.
 *   - Composio configured for the workspace       → composio (a pasted key or COMPOSIO_API_KEY)
 *   - GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET set → native
 *   - neither                                     → composio (today's page: the setup card)
 *
 * The row shape matches what the retired native route wrote (6bb69320^ oauthGoogle.mjs) so
 * @nous/core refreshGoogleToken reads it unchanged: access_token / refresh_token encrypted,
 * expiry_date as unix ms, email and scope in plain text.
 */

import crypto from 'crypto';
import { HAS_CLOUD } from '../lib/cloud.mjs';
import { encryptValue } from './crypto.mjs';
import { loadComposioConfig } from './composio.mjs';

/** connections.managed_by for a connection made with the install's own Google OAuth app. */
export const NATIVE_GOOGLE = 'google_oauth';

const IDENTITY = ['openid', 'https://www.googleapis.com/auth/userinfo.email'];
const GMAIL_READ = 'https://www.googleapis.com/auth/gmail.readonly';
const CALENDAR_READ = 'https://www.googleapis.com/auth/calendar.readonly';

/**
 * The scopes each product asks for — read-only, the least the scans need. Gmail: list and read
 * messages (received and sent) and the mailbox address. Calendar: list events.
 */
export const GOOGLE_PRODUCTS = {
  gmail_oauth: {
    display: 'Gmail',
    scopes: [...IDENTITY, GMAIL_READ],
    required: GMAIL_READ,   // the one scope the scans cannot work without
  },
  google_calendar: {
    display: 'Google Calendar',
    scopes: [...IDENTITY, CALENDAR_READ],
    required: CALENDAR_READ,
  },
};

/** URL segment or provider name → provider name. `gmail` and `calendar` are the short forms. */
export function googleProviderName(segment) {
  const s = String(segment || '').toLowerCase();
  if (s === 'gmail' || s === 'gmail_oauth') return 'gmail_oauth';
  if (s === 'calendar' || s === 'google_calendar' || s === 'gcal') return 'google_calendar';
  return null;
}

/**
 * The callback URL registered on the Google OAuth client. GOOGLE_OAUTH_REDIRECT_URI when it is
 * set to a real value; otherwise derived from the API's own address (API_URL, or API_DOMAIN —
 * the variable every self-host install sets). The nous.env.example placeholder counts as unset.
 * The worker has the same rule (apps/worker/src/utils/googleNative.mjs), so both sides agree on
 * whether native Google is configured.
 */
export function googleRedirectUri(env = process.env) {
  const set = String(env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();
  if (set && !/yourdomain\.com/i.test(set)) return set;
  const api = String(env.API_URL || (env.API_DOMAIN ? `https://${env.API_DOMAIN}` : '')).trim().replace(/\/+$/, '');
  if (!api || /yourdomain\.com/i.test(api)) return null;
  return `${api}/api/oauth/google/callback`;
}

/** The install has a complete Google OAuth app configured. */
export function nativeGoogleConfigured(env = process.env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && googleRedirectUri(env));
}

/** Did the member grant the scope this product needs? Google's consent lets them untick it. */
export function grantedRequiredScope(provider, scopeString) {
  const need = GOOGLE_PRODUCTS[provider]?.required;
  if (!need) return false;
  return String(scopeString || '').split(/\s+/).includes(need);
}

/**
 * 'native' | 'composio' for this workspace. `hasCloud` and `loadComposio` are injectable for
 * tests; Composio config is only read when it could change the answer.
 */
export async function connectMode(supabase, workspaceId, {
  env = process.env, hasCloud = HAS_CLOUD, loadComposio = loadComposioConfig,
} = {}) {
  if (hasCloud) return 'composio';
  if (!nativeGoogleConfigured(env)) return 'composio';
  const cfg = await loadComposio(supabase, workspaceId).catch(() => null);
  return cfg?.apiKey ? 'composio' : 'native';
}

// ── State (CSRF) + PKCE ───────────────────────────────────────────────────────
//
// The callback is a redirect from Google and carries no session, so the state parameter is what
// ties it to the member who started it. It is 32 random bytes, kept server-side with the
// workspace, member, provider and PKCE verifier, single use, and dead after ten minutes.

const STATE_TTL_MS = 10 * 60 * 1000;
const states = new Map();
setInterval(() => {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [k, v] of states) if (v.createdAt < cutoff) states.delete(k);
}, 60_000).unref?.();

export function createOAuthState({ workspaceId, userId, provider, now = Date.now() }) {
  const state = crypto.randomBytes(32).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  states.set(state, { workspaceId, userId, provider, verifier, createdAt: now });
  return { state, challenge };
}

/** The state's data, once. Null when unknown, already used, or expired. */
export function consumeOAuthState(state, { now = Date.now() } = {}) {
  if (!state || typeof state !== 'string') return null;
  const data = states.get(state);
  if (!data) return null;
  states.delete(state);
  if (now - data.createdAt > STATE_TTL_MS) return null;
  return data;
}

// ── Completion (binds the finish to the member's own session) ─────────────────
//
// The callback is unauthenticated, so it must not save anything: whoever's browser lands on it
// is whoever clicked the consent link, and that need not be the member who started the flow
// (member B could send their auth link to admin A). So the callback only parks Google's code
// under a one-time completion code and hands that to the popup. The app page that opened the
// popup — same origin only — POSTs it to /complete with its own session, and the server saves
// only when that session is the member who started the flow, in the same workspace.

const completions = new Map();
setInterval(() => {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [k, v] of completions) if (v.createdAt < cutoff) completions.delete(k);
}, 60_000).unref?.();

export function parkCompletion(pending, googleCode, { now = Date.now() } = {}) {
  const code = crypto.randomBytes(32).toString('hex');
  completions.set(code, { ...pending, googleCode, createdAt: now });
  return code;
}

/** The parked flow, once — and only for the member and workspace that started it. */
export function takeCompletion(code, { userId, workspaceId, now = Date.now() } = {}) {
  if (!code || typeof code !== 'string') return { error: 'invalid_completion' };
  const data = completions.get(code);
  if (!data) return { error: 'invalid_completion' };
  completions.delete(code);   // single use, even when refused below
  if (now - data.createdAt > STATE_TTL_MS) return { error: 'invalid_completion' };
  if (!userId || data.userId !== userId) return { error: 'not_your_connection' };
  if (!workspaceId || data.workspaceId !== workspaceId) return { error: 'not_your_connection' };
  return { data };
}

/** Burn a completion code nobody will redeem (the hand-off page could not deliver it). */
export function discardCompletion(code) {
  if (!code || typeof code !== 'string') return false;
  return completions.delete(code);
}

/** Test/inspection helper: is this completion code still redeemable? */
export function completionPending(code) {
  return completions.has(code);
}

export function buildAuthUrl({ provider, state, challenge, env = process.env }) {
  const product = GOOGLE_PRODUCTS[provider];
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', googleRedirectUri(env));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', product.scopes.join(' '));
  url.searchParams.set('access_type', 'offline');          // a refresh token, so the scans run unattended
  url.searchParams.set('prompt', 'consent');               // …every time, including a reconnect
  url.searchParams.set('include_granted_scopes', 'true');  // Gmail then Calendar is one growing grant
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

// ── Token exchange ────────────────────────────────────────────────────────────

export async function exchangeCode({ code, verifier, env = process.env, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirectUri(env),
      code_verifier: verifier,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error || !body.access_token) {
    throw new Error(`token_exchange_failed: ${body.error_description || body.error || res.status}`);
  }
  return body;
}

/** The Google account's address, from the OpenID userinfo endpoint. */
export async function fetchGoogleEmail(accessToken, { fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.email) throw new Error(`userinfo_failed: ${body.error || res.status}`);
  return String(body.email).trim().toLowerCase();
}

/**
 * What goes in encrypted_credentials. Secrets encrypted; metadata plain (the worker's
 * scope checks and refreshGoogleToken read them as they are). Google sends a refresh token on
 * every consent we ask for, but if one is ever missing the stored one is kept.
 */
export function credentialsFromTokens(tokens, { email, previous = null, now = Date.now() }) {
  const refresh = tokens.refresh_token ? encryptValue(tokens.refresh_token) : (previous?.refresh_token ?? null);
  return {
    access_token: encryptValue(tokens.access_token),
    refresh_token: refresh,
    expiry_date: now + (Number(tokens.expires_in) || 3600) * 1000,
    scope: tokens.scope || null,
    token_type: tokens.token_type || 'Bearer',
    email,
  };
}

/**
 * Upsert the member's connection for this Google account. Keyed on (workspace, provider, name)
 * with name = the address, the same key the retired native route and the Composio rows use, so
 * reconnecting the same mailbox updates it in place and a second mailbox is a second row.
 */
export async function saveNativeGoogleConnection(supabase, { workspaceId, userId, provider, email, tokens }) {
  if (!userId) throw Object.assign(new Error('no member to own the connection'), { code: 'connected_by_another_member' });
  const { data: prow } = await supabase.from('workflow_providers')
    .select('id').eq('name', provider).maybeSingle();
  if (!prow) throw new Error(`provider ${provider} is not seeded`);

  const key = (q) => q.eq('workspace_id', workspaceId).eq('provider_id', prow.id).eq('name', email);
  const cols = 'id, workspace_id, owner_user_id, account_email, managed_by';

  // Only to carry a stored refresh token forward if Google sent none. Never decides ownership.
  const { data: prior } = await key(supabase.from('workflow_provider_connections')
    .select('owner_user_id, encrypted_credentials')).maybeSingle();
  const previous = prior?.owner_user_id === userId ? prior.encrypted_credentials : null;

  const values = {
    encrypted_credentials: credentialsFromTokens(tokens, { email, previous }),
    managed_by: NATIVE_GOOGLE,
    composio_connection_id: null,
    composio_trigger_ids: [],
    account_email: email,
    is_verified: true,
    last_test_at: new Date().toISOString(),
  };

  // 1. A new mailbox: INSERT … ON CONFLICT DO NOTHING. Two members racing for the same mailbox
  //    cannot both insert; the loser falls through to step 2 and is refused there.
  const { data: inserted, error: insErr } = await supabase.from('workflow_provider_connections')
    .upsert({
      ...values, workspace_id: workspaceId, provider_id: prow.id, name: email,
      owner_user_id: userId, created_by: userId,
    }, { onConflict: 'workspace_id,provider_id,name', ignoreDuplicates: true })
    .select(cols);
  if (insErr) throw new Error(insErr.message);
  if (inserted?.length) return inserted[0];

  // 2. The row exists: update it only WHERE it is this member's. Another member's row, and a row
  //    with no recorded owner, are not claimable here — zero rows updated → 409. The guard is in
  //    the statement, so there is no window between checking the owner and writing.
  const { data: updated, error: updErr } = await key(supabase.from('workflow_provider_connections')
    .update(values))
    .eq('owner_user_id', userId)
    .select(cols);
  if (updErr) throw new Error(updErr.message);
  if (updated?.length) return updated[0];

  const err = new Error('This Google account is already connected by another member of the workspace.');
  err.code = 'connected_by_another_member';
  throw err;
}

/**
 * Disconnecting one connection must not cut off another. Google keeps ONE grant per Google
 * account per OAuth client, and this install has one client: Gmail and Calendar on the same
 * account share it (include_granted_scopes), and so does the same account connected in another
 * workspace on this install, by anyone. Revoking a token revokes that whole grant. So it is
 * revoked only when no other native connection anywhere on the install reads the same account.
 */
export async function shouldRevokeNativeGrant(supabase, conn) {
  const email = String(conn?.account_email || conn?.encrypted_credentials?.email || '').trim().toLowerCase();
  if (!email) return true;
  const { data } = await supabase.from('workflow_provider_connections')
    .select('id')
    .eq('managed_by', NATIVE_GOOGLE)
    .eq('account_email', email)
    .neq('id', conn.id)
    .limit(1);
  return !(data && data.length);
}
