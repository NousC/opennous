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
import { normalizeCredentials } from './credentials.mjs';
import { revokeConnectionTokens } from './revoke.mjs';
import { disconnectComposioConnection } from './composio.mjs';
import { NATIVE_GOOGLE, shouldRevokeNativeGrant } from './googleNative.mjs';
import { auditLog, recordConnectionRemovals } from '../lib/audit.mjs';
import { ingestOnConnect } from '../lib/connectIngest.mjs';
import { sourceScope } from './sourceScope.mjs';
import { recogniseOwnPeople } from '@nous/core';

/**
 * @returns {Promise<{ok: true, connection, note: string|null, webhookRegistered: boolean}
 *                  | {ok: false, status: number, error: string, message?: string}}
 */
/** `wanted`, or the first "wanted 2", "wanted 3"… not held by someone else's personal source. */
async function personalConnectionName(supabase, { workspaceId, providerId, userId, wanted, personal }) {
  if (!personal) return wanted;
  const { data: rows } = await supabase
    .from('workflow_provider_connections')
    .select('name, owner_user_id')
    .eq('workspace_id', workspaceId).eq('provider_id', providerId);
  const takenByOthers = new Set((rows || []).filter(r => r.owner_user_id !== userId).map(r => r.name));
  if (!takenByOthers.has(wanted)) return wanted;
  for (let n = 2; ; n++) if (!takenByOthers.has(`${wanted} ${n}`)) return `${wanted} ${n}`;
}

export async function connectProvider({
  supabase, workspaceId, providerName, credentials, connectionName, userId,
}) {
  const name = String(providerName || '').toLowerCase();
  // Normalised once, here: what we test, what we subscribe the webhook with, and what we
  // store are then the same string — never "works in the test, 401 from the worker".
  credentials = normalizeCredentials(credentials);

  const { data: row } = await supabase
    .from('workflow_providers')
    .select('id, name, display_name, auth_type, webhook_mode, category')
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
    const sub = await handler.subscribe(apiKey, workspaceId, credentials || {});

    if (sub?.error) {
      console.error(`[CONNECT/${row.name}] webhook subscribe failed:`, sub.error, sub.detail || sub.message || '');
      note = sub.note
        || `Connected, but we could not set up the ${row.display_name} webhook automatically (${sub.error}). Your key works; live events will not arrive until this is fixed.`;
    } else {
      Object.assign(encrypted, sub?.plain ?? {});
      // A webhook can register and still be narrower than asked (Fellow without a Super
      // Admin key gets the owner's meetings, not the workspace's). Say so.
      note = sub?.note ?? null;
      for (const [k, v] of Object.entries(sub?.secret ?? {})) encrypted[k] = encryptValue(v);
      webhookRegistered = true;
    }
  }

  // Captured in plaintext because the blob is encrypted and we cannot read it back, and
  // outbound email has to attribute to the right mailbox and the right rep.
  //
  // When the form carries no address, the provider is asked who it is: RingCentral already knows
  // from the JWT it just validated, HubSpot names a CRM owner. That address is the second source of
  // evidence for the workspace's OWN domain (GET-291) — the fact that tells a client's staff from
  // their customers, and the one four separate bugs were guessing at.
  const accountEmail = (credentials?.email || credentials?.username || '').trim().toLowerCase()
    || String(test?.accountEmail ?? '').trim().toLowerCase()
    || null;

  // Connections are unique on (workspace, provider, name), and the upsert below replaces
  // the row that holds that name. A personal source is invisible to teammates, so the page
  // offers "Fireflies.ai" to a member whose co-founder already has a "Fireflies.ai" — and
  // saving it would overwrite HIS credentials and make it hers. Give hers its own name.
  const connName = await personalConnectionName(supabase, {
    workspaceId, providerId: row.id, userId,
    wanted: connectionName || row.display_name || row.name,
    personal: sourceScope(row.name, row.category) === 'personal',
  });

  const { data: connection, error } = await supabase
    .from('workflow_provider_connections')
    .upsert({
      workspace_id:          workspaceId,
      provider_id:           row.id,
      name:                  connName,
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

  // A new source is connected, so pull what it holds — RIGHT NOW, not when someone
  // remembers to press a button. For a CRM that means importing contacts, companies and
  // deals and then backfilling their history; for anything else it means backfilling the
  // history this tool can add. Fire-and-forget: a CRM pull takes minutes and the connect
  // response must not wait on it, and nothing in here may fail the connect.
  // WHO WE ARE, BEFORE WE INGEST ANYTHING. This connection may have just supplied the second piece
  // of evidence for the workspace's own domain, and the import below resolves people. Run in
  // between and a new workspace files its first meetings onto its own staff, then self-corrects an
  // hour later on the sweep — in exactly the window a client forms their first impression.
  // Awaited, and never allowed to fail the connect.
  try {
    const { marked } = await recogniseOwnPeople(supabase, workspaceId);
    if (marked) console.log(`[CONNECT] ws=${workspaceId} recognised ${marked} of our own people before ingest`);
  } catch (e) {
    console.warn('[CONNECT] own-domain recognition skipped:', e?.message || e);
  }

  ingestOnConnect(workspaceId, name, { supabase, userId })
    .catch(e => console.error('[CONNECT] ingest failed:', e?.message || e));

  auditLog({
    actor_user_id: userId ?? null,
    action: 'integration.connect',
    target_type: 'connection',
    target_id: connection?.id,
    target_workspace_id: workspaceId,
    metadata: { provider: name },
  });

  return { ok: true, connection, note, webhookRegistered };
}

/**
 * Disconnecting. Tear down the webhook we created before dropping the row, or we leave a
 * live subscription in someone else's account pointing at a URL that will 401 forever.
 *
 * Best-effort: a provider that refuses the delete must not block the user from removing
 * the connection on our side.
 */
export async function disconnectProvider({ supabase, connectionId, actor = null, via = 'disconnect_route' }) {
  const { data: conn } = await supabase
    .from('workflow_provider_connections')
    .select('id, workspace_id, name, managed_by, account_email, composio_connection_id, composio_trigger_ids, encrypted_credentials, workflow_providers!inner(name)')
    .eq('id', connectionId)
    .maybeSingle();
  // Who removed it and how, on the audit trail (GET-901); a removed Slack connection is also told.
  const recorded = () => { if (conn) recordConnectionRemovals(supabase, [conn], { actor, via }); };

  // Composio-managed connections (Gmail / Calendar): tear down the triggers + connected
  // account at Composio, then drop our row. There is no native webhook or OAuth token to revoke.
  if (conn?.managed_by === 'composio') {
    await disconnectComposioConnection({ supabase, connection: conn });
    await supabase.from('workflow_provider_connections').delete().eq('id', connectionId);
    recorded();
    return { ok: true };
  }

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

  // Revoke the OAuth grant at the provider (Google/Slack) so disconnect actually
  // severs access, not just deletes our row. A native Google connection (GET-765) shares its
  // grant with the member's other Google product on the same account; that one keeps it.
  if (conn && (conn.managed_by !== NATIVE_GOOGLE || await shouldRevokeNativeGrant(supabase, conn))) {
    await revokeConnectionTokens(conn);
  }

  await supabase.from('workflow_provider_connections').delete().eq('id', connectionId);
  recorded();
  return { ok: true };
}
