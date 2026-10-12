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
