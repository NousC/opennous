// Unresolved-ingest queue helpers.
//
// A meeting transcript that resolves to zero contacts — but clearly had an
// external party — is captured here instead of being dropped after the
// "0 contacts updated" log line. An agent lists the queue (list_unresolved),
// decides who each belongs to, and resolves it (resolve_meeting), which re-fires
// the normal pipeline against the chosen contact. See the v2/unresolved routes.
//
// Fire-and-forget: never throw into a webhook handler.

// Upsert a pending row. Re-deliveries of the same meeting bump last_seen_at and
// refresh the detected fields, but never resurrect a row already resolved/dismissed.
export async function recordUnresolved(supabase, {
  workspaceId, source, kind = 'meeting', externalId,
  title = null, occurredAt = null, detectedNames = [], detectedEmails = [], summary = null, raw = null,
}) {
  try {
    const names  = [...new Set((detectedNames  || []).filter(Boolean).map(s => String(s).trim()).filter(Boolean))];
    const emails = [...new Set((detectedEmails || []).filter(Boolean).map(s => String(s).toLowerCase().trim()).filter(Boolean))];
    await supabase.from('unresolved_ingest').upsert({
      workspace_id: workspaceId,
      source, kind, external_id: externalId,
      title, occurred_at: occurredAt,
      detected_names: names, detected_emails: emails,
      summary, raw: raw || null,
      status: 'pending',
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,source,external_id', ignoreDuplicates: false });
  } catch (e) {
    // A missing table (not yet migrated) or any write error must not break ingest.
    if (e?.code === '42P01' || e?.code === 'PGRST205') {
      console.warn('[UNRESOLVED_INGEST] table not migrated — skipping capture. Apply supabase/migrations/2026_08_25_unresolved_ingest.sql');
    } else {
      console.warn('[UNRESOLVED_INGEST] capture failed:', e?.message || e);
    }
  }
}

// Mark a captured row resolved once its meeting has been successfully re-ingested
// against a chosen entity. Keyed by (workspace, source, externalId) so the worker
// can close it without carrying the row id.
export async function markUnresolvedResolved(supabase, { workspaceId, source, externalId, entityId }) {
  try {
    await supabase.from('unresolved_ingest')
      .update({ status: 'resolved', resolved_entity_id: entityId ?? null, resolved_at: new Date().toISOString() })
      .eq('workspace_id', workspaceId).eq('source', source).eq('external_id', externalId)
      .neq('status', 'resolved');
  } catch { /* never block */ }
}
