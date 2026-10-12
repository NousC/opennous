// Which address a draft goes to (GET-255).
//
// Three draft paths picked "the highest-confidence email identifier" and never looked at status, so
// A rep's draft went to an old address at the customer's previous domain, an address identity resolution had already retired.
// A draft goes to an ACTIVE address, and to the one they last actually wrote from when we have it.

/** The address to write to, or null. System read: addresses and times only. */
export async function pickRecipientEmail(supabase, workspaceId, entityId) {
  const { data: ids } = await supabase.from('entity_identifiers')
    .select('value, confidence, last_seen_at')
    .eq('workspace_id', workspaceId).eq('entity_id', entityId).eq('kind', 'email').eq('status', 'active');
  const active = (ids || []).map((r) => ({ ...r, value: String(r.value || '').trim().toLowerCase() })).filter((r) => r.value.includes('@'));
  if (!active.length) return null;
  if (active.length === 1) return active[0].value;

  // The address on their newest message to us.
  const { data: inbound } = await supabase.from('observations')
    .select('from:raw->participants->>from, legacy_from:raw->>from, observed_at')
    .eq('workspace_id', workspaceId).eq('entity_id', entityId)
    .in('property', ['interaction.email_received', 'interaction.email_reply', 'interaction.reply'])
    .order('observed_at', { ascending: false }).limit(20);
  const known = new Set(active.map((r) => r.value));
  for (const m of inbound || []) {
    const from = String(m.from || m.legacy_from || '').toLowerCase().match(/[^\s<>"']+@[^\s<>"']+/)?.[0];
    if (from && known.has(from)) return from;
  }
  return active.sort((a, b) =>
    (Number(b.confidence) || 0) - (Number(a.confidence) || 0)
    || String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')))[0].value;
}
