import crypto from 'crypto';
import { getSupabaseClient } from '@nous/core';

export async function verifyApiKey(req, res, next) {
  const rawKey =
    req.headers['x-api-key'] ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);

  if (!rawKey) return res.status(401).json({ error: 'api_key_required' });

  const supabase = getSupabaseClient();
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  const { data: keyRow } = await supabase
    .from('api_keys')
    .select('id, workspace_id, owner_user_id, scope')
    .eq('key_hash', keyHash)
    .is('revoked_at', null)
    .maybeSingle();

  if (!keyRow) return res.status(401).json({ error: 'invalid_api_key' });

  // Fire-and-forget last_used update
  supabase.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', keyRow.id).then(() => {});

  req.workspaceId = keyRow.workspace_id;
  req.apiKeyId = keyRow.id;
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
