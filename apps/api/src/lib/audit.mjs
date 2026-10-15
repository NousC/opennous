import { getSupabaseClient } from '@nous/core';

// Append-only audit-log writer. FIRE-AND-FORGET: recording an action must never
// break or slow the action itself, so failures are swallowed with a warning.
export function auditLog({
  actor_user_id = null,
  actor_email = null,
  action,
  target_type = null,
  target_id = null,
  target_workspace_id = null,
  metadata = {},
  ip = null,
}) {
  try {
    const supabase = getSupabaseClient();
    supabase.from('audit_log').insert({
      actor_user_id,
      actor_email,
      action,
      target_type,
      target_id: target_id != null ? String(target_id) : null,
      target_workspace_id,
      metadata,
      ip,
    }).then(({ error }) => { if (error) console.warn('[audit_log]', action, error.message); });
  } catch (e) {
    console.warn('[audit_log] write failed:', e?.message);
  }
}

// Pull actor identity + IP from an authenticated request, merge caller fields.
export function auditFromReq(req, fields) {
  return auditLog({
    actor_user_id: req.internalUserId ?? null,
    actor_email: req.user?.email ?? null,
    ip: req.ip ?? null,
    ...fields,
  });
}

/**
 * A removed integration connection, recorded (GET-901). Every path that deletes a
 * workflow_provider_connections row calls this: the disconnect route, account erasure, workspace
 * deletion (the cascade), the admin delete. One audit row per connection, action
 * 'integration.disconnect' (what Settings > Activity already reads; metadata.provider stays the
 * connection's display name), plus provider_type (the provider's slug), via (which path) and, for
 * Slack, the team and bot user (plaintext ids, never a token), and one log line. A removed Slack
 * connection is then told to the workspace's owners/admins and ops once (Cloud's slackHealth,
 * through lib/cloud.mjs). Fire-and-forget: never throws, never slows the delete.
 *
 * conns: [{ id, workspace_id, name, provider (slug) | workflow_providers.name, encrypted_credentials? }]
 * actor: { user_id?, email?, ip? } (null for a system path). via: 'disconnect_route' | 'account_erasure' | …
 */
export function recordConnectionRemovals(supabase, conns, { actor = null, via = 'unknown', cloud = null, audit = auditLog, log = console.log } = {}) {
  for (const c of conns ?? []) {
    try {
      if (!c?.id) continue;
      const provider = String(c.provider ?? c.workflow_providers?.name ?? c.provider_name ?? '').toLowerCase() || null;
      const creds = c.encrypted_credentials ?? {};
      const slack = provider === 'slack' ? { slack_team_id: creds.slack_team_id ?? null, bot_user_id: creds.bot_user_id ?? null } : {};
      log(`[connection-removed] ws=${c.workspace_id ?? '?'} provider=${provider ?? '?'} id=${c.id} via=${via} by=${actor?.user_id ?? 'system'}`);
      audit({
        actor_user_id: actor?.user_id ?? null, actor_email: actor?.email ?? null, ip: actor?.ip ?? null,
        action: 'integration.disconnect', target_type: 'connection', target_id: c.id, target_workspace_id: c.workspace_id ?? null,
        metadata: { provider: c.name ?? provider, provider_type: provider, via, ...slack },
      });
      if (provider === 'slack') {
        Promise.resolve(cloud ?? import('./cloud.mjs').then(m => m.loadCloud()))
          .then(m => m?.slackHealth?.connectionRemoved?.({ supabase, workspaceId: c.workspace_id, connectionId: c.id, provider, actor, via }))
          .catch(e => console.warn('[connection-removed] slack alert failed:', e?.message ?? e));
      }
    } catch (e) {
      console.warn('[connection-removed] record failed:', e?.message ?? e);
    }
  }
}

/** The connections of these workspaces, read before a delete cascades them away. Never throws. */
export async function connectionsOfWorkspaces(supabase, workspaceIds) {
  if (!workspaceIds?.length) return [];
  try {
    const { data } = await supabase.from('workflow_provider_connections')
      .select('id, workspace_id, name, encrypted_credentials, workflow_providers(name)').in('workspace_id', workspaceIds);
    return data ?? [];
  } catch { return []; }
}
