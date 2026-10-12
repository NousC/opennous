// The worker's Composio client. One factory, so every caller gets the pinned toolkit version.
//
// The API side learned this the hard way (apps/api/src/providers/composio.mjs): the SDK
// defaults `toolkitVersions` to 'latest', and tools.execute() THROWS on 'latest'. The worker
// built its own bare `new Composio({ apiKey })` in the backfill, so every backfill execute in
// the worker failed the same way (GET-221). Build clients here, nowhere else.

import { Composio } from '@composio/core';
import { decrypt } from './encryption.mjs';

const _clients = new Map();

/** The workspace's Composio client (self-serve key, decrypted; env as the single-tenant fallback), or null. */
export async function workspaceComposio(supabase, workspaceId) {
  let row = null;
  try {
    const { data } = await supabase
      .from('workspace_composio_config').select('encrypted_api_key, base_url').eq('workspace_id', workspaceId).maybeSingle();
    row = data;
  } catch { /* table absent → env */ }
  const apiKey = row?.encrypted_api_key ? decrypt(row.encrypted_api_key) : process.env.COMPOSIO_API_KEY;
  const baseUrl = row?.base_url || process.env.COMPOSIO_BASE_URL || null;
  if (!apiKey) return null;

  const key = `${apiKey}|${baseUrl || ''}`;
  let client = _clients.get(key);
  if (!client) {
    client = new Composio({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
      toolkitVersions: process.env.COMPOSIO_TOOLKIT_VERSION || '20250909_00',
    });
    _clients.set(key, client);
  }
  return client;
}
