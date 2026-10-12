import crypto from 'crypto';
import { getSupabaseClient } from '@nous/core';
import { trackApiKeyRequest } from '../lib/apiRequestLog.mjs';

// The only WRITE-side v2 endpoints a read-only key may still call — they read/compute
// but never mutate the graph, and the MCP invokes them over POST. Everything else that
// isn't a GET is treated as a write and blocked for a read-only key (fail-closed).
const READ_ONLY_POST_PATHS = ['/v2/context', '/v2/query', '/v2/score', '/v2/verify', '/v2/company/search', '/v2/notes/search'];
function readOnlyKeyMayCall(req) {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  if (m !== 'POST') return false;
  const path = (req.originalUrl || req.url || '').split('?')[0];
  return READ_ONLY_POST_PATHS.some((p) => path === p || path.startsWith(p + '/'));
}

/**
 * The middleware, over a Supabase client getter (tests pass a fake). It looks the key up on every
 * request, revoked_at included, and keeps no cache: a revoked key fails from its next call, and one
 * restored by undo (POST /api/workspace/api-keys/:id/restore) works again from its next call.
 */
export function createVerifyApiKey(getClient = getSupabaseClient) {
  return (req, res, next) => verify(getClient, req, res, next);
}

export const verifyApiKey = createVerifyApiKey();

async function verify(getClient, req, res, next) {
  const rawKey =
    req.headers['x-api-key'] ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);

  if (!rawKey) return res.status(401).json({ error: 'api_key_required' });

  const supabase = getClient();
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  // An OAuth access token (nat_, GET-762) resolves to the api_keys row its grant
  // minted, so it carries exactly that key's workspace, owner, scope and capability,
  // and revoking the key ends the token.
  let keyQuery = supabase
    .from('api_keys')
    .select('id, workspace_id, owner_user_id, scope, capability, expires_at');
  if (rawKey.startsWith('nat_')) {
    const { data: tok } = await supabase
      .from('oauth_tokens')
      .select('api_key_id, expires_at')
      .eq('token_hash', keyHash)
      .eq('kind', 'access')
      .is('revoked_at', null)
      .maybeSingle();
    if (!tok) return res.status(401).json({ error: 'invalid_api_key' });
    if (new Date(tok.expires_at).getTime() <= Date.now()) {
      return res.status(401).json({ error: 'token_expired', detail: 'This access token has expired. Refresh it.' });
    }
    keyQuery = keyQuery.eq('id', tok.api_key_id);
  } else {
    keyQuery = keyQuery.eq('key_hash', keyHash);
  }

  const { data: keyRow } = await keyQuery
    .is('revoked_at', null)
    .maybeSingle();

  if (!keyRow) return res.status(401).json({ error: 'invalid_api_key' });

  // Per-key request log (GET-623): from here on the key is known, so this call is logged against
  // it, including an expired or read-only rejection below (those are the key's own errors). One
  // row on response finish, buffered, off the request path; never throws.
  req.apiKeyId = keyRow.id;
  req.apiKeyWorkspaceId = keyRow.workspace_id;
  trackApiKeyRequest(req, res);

  // Expiry: an expired key is rejected like an invalid one (but with a distinct code so
  // the caller knows to rotate rather than that the key is wrong).
  if (keyRow.expires_at && new Date(keyRow.expires_at).getTime() <= Date.now()) {
    return res.status(401).json({ error: 'api_key_expired', detail: 'This API key has expired. Create or rotate a key to get a fresh one.' });
  }

  // Capability: a read-only key can read/compute context but cannot record, modify, or
  // send. Fail-closed — anything not an explicit read is blocked. read_write and legacy
  // (null) keys are unrestricted, so existing keys are unaffected.
  const capability = keyRow.capability || 'read_write';
  if (capability === 'read_only' && !readOnlyKeyMayCall(req)) {
    return res.status(403).json({ error: 'read_only_key', detail: 'This API key is read-only — it can read context but cannot record, modify, connect, or send. Use a read/write key for write operations.' });
  }

  // Fire-and-forget last_used update
  supabase.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', keyRow.id).then(() => {});

  req.workspaceId = keyRow.workspace_id;
  req.apiKeyId = keyRow.id;
  req.keyCapability = capability;
  // getAuthContext() branches on these to enforce the API-key workspace scope;
  // without them that guard was dead code (and it would call ensureUserAndTeam
  // with an undefined user).
  req.isApiKeyAuth = true;
  req.apiKeyWorkspaceId = keyRow.workspace_id;
  // Per-member privacy (PRIVACY_MODEL.md): a member key acts AS that member, so
  // raw content is scoped to them; an admin/workspace key (no owner_user_id) sees
  // all raw. This is the ONLY point the agent gets a viewer identity, since the
  // MCP session otherwise carries only a workspace. Legacy keys (null owner) keep
  // full access, so nothing breaks on deploy.
  req.memberUserId = keyRow.owner_user_id ?? null;
  req.viewerScope  = keyRow.owner_user_id ? (keyRow.scope || 'member') : 'admin';
  // Normalize client identifier: mcp, sdk (sdk-node → sdk), or api
  const rawClient = (req.headers['x-nous-client'] || '').toLowerCase();
  req.clientType = rawClient === 'mcp' ? 'mcp' : rawClient.startsWith('sdk') ? 'sdk' : 'api';
  next();
}
