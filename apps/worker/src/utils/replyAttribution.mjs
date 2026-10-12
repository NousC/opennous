// Recover which sequence step/variant a reply is answering.
//
// Cold-email providers (Instantly, and later Smartlead/EmailBison/lemlist) stamp
// step/variant on SENT events, NOT on reply events — so a reply lands with
// step/variant null and we'd know the campaign but not which email earned it.
// Every send is already logged per-lead as an `email_sent` observation carrying
// step/variant, so we recover attribution by finding this contact's most recent
// send in the same campaign at or before the reply.
//
// This is the join that turns "someone in campaign X replied" into "variant B of
// step 2 earned this positive reply" — the unit feedback loops are built on.
//
// Returns { step, variant, subject } (any field null if unknown), or null when no
// attributable prior send is found. Best-effort: never throws into ingestion.

const ATTRIBUTABLE_SENT = 'interaction.email_sent';

export async function resolveReplyAttribution(supabase, {
  workspaceId, entityId, source, campaignId, before,
}) {
  if (!workspaceId || !entityId || !campaignId) return null;
  try {
    const { data, error } = await supabase
      .from('observations')
      .select('raw, observed_at')
      .eq('workspace_id', workspaceId)
      .eq('entity_id', entityId)
      .eq('property', ATTRIBUTABLE_SENT)
      .eq('source', source)
      .eq('raw->>campaign_id', String(campaignId))
      .lte('observed_at', before || new Date().toISOString())
      .order('observed_at', { ascending: false })
      .limit(1);
    if (error || !data || !data.length) return null;
    const raw = data[0].raw || {};
    if (raw.step == null && raw.variant == null && raw.subject == null) return null;
    return {
      step:    raw.step ?? null,
      variant: raw.variant ?? null,
      subject: raw.subject ?? null,
    };
  } catch {
    return null;
  }
}
