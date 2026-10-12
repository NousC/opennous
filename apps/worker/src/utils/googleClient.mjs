// Which transport reads a Google connection (GET-765). One function, so gmailSync, calendarSync
// and gmailBody never branch on it themselves.
//
//   managed_by 'composio'      → the workspace's Composio client (Cloud, and self-hosters who
//                                configured Composio)
//   managed_by 'google_oauth'  → the install's own Google OAuth app (utils/googleNative.mjs)
//
// Both answer tools.execute(slug, { arguments }) in Composio's shape, so everything downstream —
// ingestGmail, recordCalendarEvent, dedup, privacy — is the same code for both.

import { workspaceComposio } from './composioClient.mjs';
import { NATIVE_GOOGLE, isNativeGoogle, nativeGoogleClient, nativeGoogleEnabled } from './googleNative.mjs';

/** A client for this connection, or null when its transport is not configured here. */
export async function googleClientFor(supabase, conn) {
  if (isNativeGoogle(conn)) {
    if (!nativeGoogleEnabled()) return null;
    if (conn.encrypted_credentials === undefined) {
      // Callers that scan many connections select only ids; the tokens are read when needed.
      const { data } = await supabase.from('workflow_provider_connections')
        .select('encrypted_credentials').eq('id', conn.id).maybeSingle();
      conn.encrypted_credentials = data?.encrypted_credentials ?? null;
    }
    return nativeGoogleClient(supabase, conn);
  }
  if (!conn?.composio_connection_id) return null;
  return workspaceComposio(supabase, conn.workspace_id);
}

/** The connection can be read by some transport (a Composio account id, or our own tokens). */
export const hasGoogleTransport = (conn) => Boolean(conn?.composio_connection_id) || isNativeGoogle(conn);

/** Why googleClientFor returned null, in the words the scans already log. */
export const noClientError = (conn) => (isNativeGoogle(conn) ? 'google_oauth_not_configured' : 'composio_not_configured');

/**
 * Mailboxes or calendars connected with the install's own Google OAuth app (GET-765). Only read
 * when that app is configured, and only rows the API's native Google callback wrote — Cloud never
 * writes one, so the Composio scans read exactly what they read before.
 */
export async function nativeConnections(supabase, providerName, { workspaceId = null } = {}) {
  if (!nativeGoogleEnabled()) return [];
  let q = supabase
    .from('workflow_provider_connections')
    .select('id, workspace_id, owner_user_id, account_email, managed_by, composio_connection_id, workflow_providers!inner(name)')
    .eq('is_verified', true)
    .eq('managed_by', NATIVE_GOOGLE)
    .eq('workflow_providers.name', providerName);
  if (workspaceId) q = q.eq('workspace_id', workspaceId);
  const { data, error } = await q;
  if (error) { console.error(`[GOOGLE] ${providerName} native connections query failed:`, error.message); return []; }
  return data || [];
}
