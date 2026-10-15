// The workspace's Slack connection as the RevBox surfaces read it (GET-901): is there one, and does it
// still work. One small read; no credentials leave the database.

/**
 * -> { connected, working, connection_id } | null when it cannot be read (the surfaces then show no
 * connection state rather than a wrong one). `working` is false once a post or a Slack event has
 * marked the connection broken (is_verified false); a reconnect sets it back.
 */
export async function slackConnectionState(sb, workspaceId) {
  if (!sb || !workspaceId) return null;
  const { data, error } = await sb.from('workflow_provider_connections')
    .select('id, is_verified, created_at, workflow_providers!inner(name)')
    .eq('workspace_id', workspaceId).eq('workflow_providers.name', 'slack')
    .order('created_at', { ascending: false }).limit(1);
  if (error) return null;
  const row = data?.[0];
  if (!row) return { connected: false, working: false, connection_id: null };
  return { connected: true, working: row.is_verified !== false, connection_id: row.id };
}
