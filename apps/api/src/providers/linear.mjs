/**
 * Linear (GET-825): the workspace's connection, and a GraphQL caller built from it.
 *
 * Installed as the app (actor=app), so issues show up as created by OpenNous rather than by
 * whoever connected it, and the app is not a billable Linear seat. A company tool: one connection
 * per workspace, connected by an owner or admin (sourceScope.mjs).
 *
 * Linear's tokens last 24 hours and come with a refresh token. getLinearClient refreshes a token
 * that is about to expire before it calls, and stores the NEW refresh token (Linear rotates it).
 *
 * The redirect URI is LINEAR_REDIRECT_URI, or <API_URL>/api/workflow-providers/linear/oauth/callback,
 * registered on the Linear OAuth app. The app needs LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET.
 */

import crypto from 'crypto';
import { encryptValue as encrypt, decrypt } from './crypto.mjs';

const AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
const TOKEN_URL = 'https://api.linear.app/oauth/token';
export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

// Read the workspace, create issues and their attachments, and comment. Not `admin`: the
// webhook for status sync is configured on the OAuth app itself, so we never need it.
export const LINEAR_SCOPES = ['read', 'write', 'issues:create', 'comments:create'];

/** Refresh when fewer than this many ms are left on the token. */
const REFRESH_MARGIN_MS = 5 * 60_000;

const env0 = () => process.env;
const trim = (v) => String(v ?? '').trim();

export function linearRedirectUri(env = env0()) {
  if (trim(env.LINEAR_REDIRECT_URI)) return trim(env.LINEAR_REDIRECT_URI);
  const api = trim(env.API_URL) || (env.API_DOMAIN ? `https://${env.API_DOMAIN}` : 'https://api.opennous.cloud');
  return `${api.replace(/\/+$/, '')}/api/workflow-providers/linear/oauth/callback`;
}

export const linearConfigured = (env = env0()) => Boolean(trim(env.LINEAR_CLIENT_ID) && trim(env.LINEAR_CLIENT_SECRET));

// ── State (CSRF) ────────────────────────────────────────────────────────────
// In memory, 10 minutes, one use. Bound to the member and workspace that started the flow.

const states = new Map();
setInterval(() => {
  const cutoff = Date.now() - 600_000;
  for (const [k, v] of states) if (v.timestamp < cutoff) states.delete(k);
}, 60_000).unref?.();   // unref: a sweep timer must never keep the process (or test runner) alive

export function createLinearState({ workspaceId, userId, connectionName = 'Linear' }) {
  const state = crypto.randomBytes(32).toString('hex');
  states.set(state, { workspaceId, userId, connectionName, timestamp: Date.now() });
  return { state };
}

export function consumeLinearState(state) {
  const v = states.get(String(state ?? ''));
  if (!v) return null;
  states.delete(String(state));
  if (Date.now() - v.timestamp > 600_000) return null;
  return v;
}

export function buildLinearAuthUrl({ state, env = env0() }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', trim(env.LINEAR_CLIENT_ID));
  url.searchParams.set('redirect_uri', linearRedirectUri(env));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', LINEAR_SCOPES.join(','));
  url.searchParams.set('state', state);
  url.searchParams.set('actor', 'app');
  // Show the consent screen every time, so an admin can pick a different Linear workspace.
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

// ── Tokens ──────────────────────────────────────────────────────────────────

async function tokenRequest(params, { env, fetchImpl }) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: trim(env.LINEAR_CLIENT_ID), client_secret: trim(env.LINEAR_CLIENT_SECRET) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw Object.assign(new Error(data.error_description || data.error || `linear token request failed (${res.status})`), { code: 'linear_token_failed' });
  }
  return data;
}

function credentialsFromTokens(tokens, previous = {}) {
  return {
    ...previous,
    access_token: encrypt(tokens.access_token),
    // Linear rotates refresh tokens; keep the old one only if none came back.
    refresh_token: tokens.refresh_token ? encrypt(tokens.refresh_token) : previous.refresh_token ?? null,
    expires_at: new Date(Date.now() + (Number(tokens.expires_in) || 86_400) * 1000).toISOString(),
    scope: tokens.scope || LINEAR_SCOPES.join(' '),
    token_type: tokens.token_type || 'Bearer',
  };
}

/** A GraphQL caller for one access token. Throws { code: 'linear_graphql' } on Linear errors. */
export function linearGql(accessToken, { fetchImpl = globalThis.fetch } = {}) {
  return async (query, variables = {}) => {
    const res = await fetchImpl(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.errors?.length) {
      const message = body.errors?.map((e) => e.message).join('; ') || `linear graphql failed (${res.status})`;
      throw Object.assign(new Error(message), { code: res.status === 401 ? 'linear_unauthorized' : 'linear_graphql', status: res.status });
    }
    return body.data;
  };
}

const Q_WORKSPACE = `query LinearWorkspace {
  organization { id name urlKey }
  teams(first: 100) { nodes { id key name } }
}`;

// ── The connection ──────────────────────────────────────────────────────────

async function providerId(supabase) {
  const { data } = await supabase.from('workflow_providers').select('id').eq('name', 'linear').maybeSingle();
  if (!data) throw Object.assign(new Error('linear provider is not seeded'), { code: 'provider_not_configured' });
  return data.id;
}

async function loadConnection(supabase, workspaceId) {
  const pid = await providerId(supabase);
  const { data } = await supabase.from('workflow_provider_connections')
    .select('id, workspace_id, encrypted_credentials').eq('workspace_id', workspaceId).eq('provider_id', pid).maybeSingle();
  return { pid, row: data ?? null };
}

/**
 * Finish the OAuth flow: exchange the code, read the Linear workspace and its teams, and save one
 * connection for this workspace. A single team becomes the default; with several, an admin picks
 * (setLinearDefaultTeam). Reconnecting keeps a pick that still exists.
 */
export async function completeLinearConnection(supabase, {
  workspaceId, userId, code, connectionName = 'Linear', env = env0(), fetchImpl = globalThis.fetch,
}) {
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: linearRedirectUri(env) }, { env, fetchImpl });
  const ws = await linearGql(tokens.access_token, { fetchImpl })(Q_WORKSPACE);
  const teams = (ws?.teams?.nodes ?? []).map((t) => ({ id: t.id, key: t.key, name: t.name }));
  const { pid, row } = await loadConnection(supabase, workspaceId);
  const kept = row?.encrypted_credentials?.default_team_id;
  const defaultTeam = teams.some((t) => t.id === kept) ? kept : teams.length === 1 ? teams[0].id : null;
  const credentials = {
    ...credentialsFromTokens(tokens),
    organization: ws?.organization ? { id: ws.organization.id, name: ws.organization.name, url_key: ws.organization.urlKey } : null,
    teams,
    default_team_id: defaultTeam,
  };
  const now = new Date().toISOString();
  if (row) {
    const { error } = await supabase.from('workflow_provider_connections')
      .update({ encrypted_credentials: credentials, is_verified: true, last_test_at: now }).eq('id', row.id);
    if (error) throw new Error(error.message);
    return { id: row.id, workspace_id: workspaceId };
  }
  const { data, error } = await supabase.from('workflow_provider_connections').insert({
    workspace_id: workspaceId, provider_id: pid, name: connectionName || 'Linear',
    encrypted_credentials: credentials, created_by: userId ?? null, is_verified: true, last_test_at: now,
  }).select('id').single();
  if (error) throw new Error(error.message);
  return { id: data.id, workspace_id: workspaceId };
}

/** The team new issues go to. Must be one of the connected workspace's teams. */
export async function setLinearDefaultTeam(supabase, { workspaceId, teamId }) {
  const { row } = await loadConnection(supabase, workspaceId);
  if (!row) throw Object.assign(new Error('Linear is not connected'), { code: 'linear_not_connected' });
  const c = row.encrypted_credentials || {};
  if (!(c.teams || []).some((t) => t.id === teamId)) throw Object.assign(new Error('Not a team in the connected Linear workspace'), { code: 'unknown_team' });
  const { error } = await supabase.from('workflow_provider_connections')
    .update({ encrypted_credentials: { ...c, default_team_id: teamId } }).eq('id', row.id);
  if (error) throw new Error(error.message);
  return { default_team_id: teamId };
}

/** What a settings screen shows: never a token. Null when Linear is not connected. */
export async function linearConnectionSummary(supabase, workspaceId) {
  const { row } = await loadConnection(supabase, workspaceId);
  if (!row) return null;
  const c = row.encrypted_credentials || {};
  return { connection_id: row.id, organization: c.organization ?? null, teams: c.teams ?? [], default_team_id: c.default_team_id ?? null };
}

/**
 * A ready GraphQL caller for the workspace's Linear, refreshing the token first when it is about to
 * expire. Returns { gql, connectionId, defaultTeamId, teams }.
 */
export async function getLinearClient(supabase, workspaceId, { env = env0(), fetchImpl = globalThis.fetch } = {}) {
  const { row } = await loadConnection(supabase, workspaceId);
  if (!row) throw Object.assign(new Error('Linear is not connected for this workspace'), { code: 'linear_not_connected' });
  let c = row.encrypted_credentials || {};
  let access = decrypt(c.access_token);
  const expiring = !c.expires_at || Date.parse(c.expires_at) - Date.now() < REFRESH_MARGIN_MS;
  if (!access || expiring) {
    const refresh = decrypt(c.refresh_token);
    if (!refresh) throw Object.assign(new Error('Linear needs to be reconnected'), { code: 'linear_reconnect_required' });
    const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh }, { env, fetchImpl });
    c = { ...c, ...credentialsFromTokens(tokens, c) };
    // Linear rotated the refresh token: losing the new one kills the connection once the old one's
    // grace window ends, so a failed save is an error, not a shrug.
    const { error } = await supabase.from('workflow_provider_connections').update({ encrypted_credentials: c }).eq('id', row.id);
    if (error) {
      console.error('[linear] could not store the rotated token:', error.message);
      throw Object.assign(new Error('Could not save the refreshed Linear token'), { code: 'linear_token_failed' });
    }
    access = tokens.access_token;
  }
  return { gql: linearGql(access, { fetchImpl }), connectionId: row.id, defaultTeamId: c.default_team_id ?? null, teams: c.teams ?? [] };
}
