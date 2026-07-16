/**
 * Connecting a provider. One function, every caller.
 *
 * There were three ways to connect a provider and they did different things:
 *
 *   Integrations page  → POST /:name/connect     tested the key, registered the webhook
 *   Settings modal     → POST /connections       tested the key, registered NOTHING
 *   The MCP agent      → POST /v2/.../integrations  tested the key, registered NOTHING
 *
 * Same user, same key, same provider — but connect Lemlist from Settings instead of the
 * Integrations page and no webhook was ever created, so nothing arrived and there was no
 * error anywhere to explain why. Three doors, three behaviours, one of them right.
 *
 * Now there is one door. Test the key, refuse it if it does not work, encrypt it,
 * register the webhook if the provider lets us, and save. Whoever is calling.
 */

import { getProvider } from './catalogue.mjs';
import { WEBHOOK_HANDLERS } from './webhooks.mjs';
import { testProviderCredentials } from './test.mjs';
import { encryptValue, encryptCredentials, decrypt } from './crypto.mjs';

/**
 * @returns {Promise<{ok: true, connection, note: string|null, webhookRegistered: boolean}
 *                  | {ok: false, status: number, error: string, message?: string}}
 */
export async function connectProvider({
  supabase, workspaceId, providerName, credentials, connectionName, userId,
}) {
  const name = String(providerName || '').toLowerCase();

  const { data: row } = await supabase
    .from('workflow_providers')
    .select('id, name, display_name, auth_type, webhook_mode')
    .eq('name', name)
    .eq('is_active', true)
    .maybeSingle();

  if (!row) {
    return { ok: false, status: 404, error: 'unknown_provider', message: `No provider named "${name}".` };
  }

  // OAuth providers cannot be connected with a pasted key, and letting a caller try means
  // letting them overwrite a live OAuth token with a string. The browser flow is the only
  // way in.
  if (row.auth_type === 'oauth2') {
    return {
      ok: false, status: 400, error: 'oauth_provider',
      message: `${row.display_name} uses a browser sign-in. Connect it from the Integrations page — a key cannot be pasted for this one.`,
    };
  }

  // Does the key work? If we cannot say yes, we do not save. A key that fails here and
  // gets saved anyway becomes an integration that shows green and ingests nothing.
  const test = await testProviderCredentials(row.name, credentials || {});
  if (!test.verified) {
    return {
      ok: false, status: 400, error: 'invalid_credentials',
      message: test.message || 'Those credentials did not work.',
    };
  }

  const encrypted = encryptCredentials(credentials || {});

  // The webhook, off the key we were just given. Nothing for the user to copy anywhere.
  //
  // A webhook failure does NOT fail the connection. A key that enriches but doesn't push
  // is worth more than no key at all, and some of these failures are the user's plan
  // rather than their mistake (Calendly gates webhooks to Standard+). We save, and we say
  // what happened — the one thing we never do is claim it worked.
  let note = null;
  let webhookRegistered = false;

  const handler = WEBHOOK_HANDLERS[row.name];
  if (handler) {
    const apiKey = credentials?.api_key || credentials?.access_token || credentials?.api_token;
    const sub = await handler.subscribe(apiKey, workspaceId);

    if (sub?.error) {
      console.error(`[CONNECT/${row.name}] webhook subscribe failed:`, sub.error, sub.detail || sub.message || '');
      note = sub.note
        || `Connected, but we could not set up the ${row.display_name} webhook automatically (${sub.error}). Your key works; live events will not arrive until this is fixed.`;
    } else {
      Object.assign(encrypted, sub?.plain ?? {});
      for (const [k, v] of Object.entries(sub?.secret ?? {})) encrypted[k] = encryptValue(v);
      webhookRegistered = true;
    }
  }

  // Captured in plaintext because the blob is encrypted and we cannot read it back, and
  // outbound email has to attribute to the right mailbox and the right rep.
  const accountEmail = (credentials?.email || credentials?.username || '').trim().toLowerCase() || null;

  const { data: connection, error } = await supabase
    .from('workflow_provider_connections')
    .upsert({
      workspace_id:          workspaceId,
      provider_id:           row.id,
      name:                  connectionName || row.display_name || row.name,
      encrypted_credentials: encrypted,
      created_by:            userId,
      owner_user_id:         userId,
      account_email:         accountEmail,
      is_verified:           true,
      last_test_at:          new Date().toISOString(),
    }, { onConflict: 'workspace_id,provider_id,name' })
    .select('id, workspace_id, provider_id, name, created_at, is_verified')
    .single();

  if (error) {
    console.error('[CONNECT] save failed:', error.message);
    return { ok: false, status: 500, error: 'save_failed', message: error.message };
  }

  return { ok: true, connection, note, webhookRegistered };
}

/**
 * Disconnecting. Tear down the webhook we created before dropping the row, or we leave a
 * live subscription in someone else's account pointing at a URL that will 401 forever.
 *
 * Best-effort: a provider that refuses the delete must not block the user from removing
 * the connection on our side.
 */
export async function disconnectProvider({ supabase, connectionId }) {
  const { data: conn } = await supabase
    .from('workflow_provider_connections')
    .select('encrypted_credentials, workflow_providers!inner(name)')
    .eq('id', connectionId)
    .maybeSingle();

  const name = conn?.workflow_providers?.name;
  const handler = name ? WEBHOOK_HANDLERS[name] : null;

  if (handler && conn?.encrypted_credentials) {
    const apiKey = decrypt(conn.encrypted_credentials.api_key || '');
    if (apiKey) {
      try {
        await handler.unsubscribe(apiKey, conn.encrypted_credentials);
      } catch (err) {
        console.warn(`[DISCONNECT/${name}]`, err.message);
      }
    }
  }

  await supabase.from('workflow_provider_connections').delete().eq('id', connectionId);
  return { ok: true };
}
