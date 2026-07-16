// Surfaces a revoked / expired Google OAuth connection so the user knows to reconnect,
// instead of the poller silently failing every hour.
//
// On a TokenRevokedError we:
//   1. Flip the connection to is_verified=false → the Integrations UI shows "Needs auth"
//      and the pollers stop selecting it (they query is_verified=true). Reconnecting via
//      OAuth flips it back to true.
//   2. Write a workspace_system_log event so it shows up in the Live Op Log as an alert.

// Did this error come from core's refreshGoogleToken signalling a dead grant?
export function isTokenRevoked(err) {
  return err?.code === 'google_token_revoked'
    || /invalid_grant|token (revoked|expired)|reconnect required/i.test(err?.message || '');
}

export async function markGoogleConnectionRevoked(supabase, conn, source) {
  try {
    await supabase
      .from('workflow_provider_connections')
      .update({ is_verified: false })
      .eq('id', conn.id);

    await supabase.from('workspace_system_log').insert({
      workspace_id: conn.workspace_id,
      source,
      event_type: 'token_revoked',
      summary: `${source} disconnected — Google access was revoked or expired. Reconnect ${source} in Integrations to resume.`,
      metadata: { connection_id: conn.id, reason: 'invalid_grant' },
      billable_ops: 0,
      occurred_at: new Date().toISOString(),
    });
    console.warn(`[TOKEN_REVOKED] ${source} connection=${conn.id} workspace=${conn.workspace_id} flagged for re-auth`);
  } catch (e) {
    console.error(`[TOKEN_REVOKED] failed to flag connection=${conn.id}:`, e.message);
  }
}
