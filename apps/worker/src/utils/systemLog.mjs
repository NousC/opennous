// Lightweight wrapper around workspace_system_log.
// Used by every inbound webhook handler so the Mind Live Op Log shows
// each delivery (and any other backend op that wants to surface there).
//
// Fire-and-forget — never throws. If the insert fails, the calling handler
// must not break.

export async function logSysEvent(supabase, { workspaceId, source, eventType, summary, contactId, metadata }) {
  try {
    await supabase.from('workspace_system_log').insert({
      workspace_id: workspaceId,
      source,
      event_type:   eventType,
      summary:      summary || null,
      contact_id:   contactId || null,
      metadata:     metadata || {},
      occurred_at:  new Date().toISOString(),
    });
  } catch { /* never block the webhook response */ }
}
