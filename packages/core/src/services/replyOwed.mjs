// Does the team owe this person a reply? (GET-255)
//
// Studio said "Rowan replied — you owe a reply" an hour after a teammate had answered him, because it
// only read the reply's sentiment and date. Owing a reply is a fact about ORDER: they wrote, and no
// one on the team has written back since — on any channel, from any teammate's account. A meeting
// or a call after their message answers it too.

const INBOUND = new Set([
  'interaction.email_received', 'interaction.email_reply', 'interaction.email_replied',
  'interaction.reply', 'interaction.positive_reply',
  'interaction.linkedin_message_received', 'interaction.linkedin_replied', 'interaction.linkedin_reply',
  'interaction.linkedin_inmail_received',
]);
const OUTBOUND = new Set([
  'interaction.email_sent', 'interaction.linkedin_message_sent', 'interaction.linkedin_inmail_sent',
  'interaction.meeting_held', 'interaction.meeting_scheduled', 'interaction.call_held', 'interaction.call_made',
]);
// A message type whose direction lives on the row.
const EITHER = new Set(['interaction.linkedin_message', 'interaction.linkedin_inmail', 'interaction.email_received']);

/** 'in' | 'out' | null for one observation row ({ property, is_outbound }). */
export function touchDirection(row) {
  const p = row?.property;
  const outbound = row?.is_outbound === true || row?.is_outbound === 'true';
  if (EITHER.has(p)) {
    if (outbound) return 'out';
    if (p === 'interaction.email_received' || row?.is_outbound === false || row?.is_outbound === 'false') return 'in';
    return null;   // a LinkedIn message with no direction can't say who owes whom
  }
  if (INBOUND.has(p)) return 'in';
  if (OUTBOUND.has(p)) return 'out';
  return null;
}

export const REPLY_TOUCH_PROPERTIES = [...new Set([...INBOUND, ...OUTBOUND, ...EITHER])];

/**
 * From one person's touches, when their unanswered message arrived — or null when nothing is owed.
 * @param {{ property: string, observed_at: string, is_outbound?: boolean|string|null }[]} rows
 * @returns {{ owed_since: string|null, last_inbound_at: string|null, last_outbound_at: string|null }}
 */
export function replyOwedFromTouches(rows) {
  let lastIn = null, lastOut = null, firstUnanswered = null;
  const sorted = [...(rows || [])].filter((r) => r?.observed_at).sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  for (const r of sorted) {
    const dir = touchDirection(r);
    if (dir === 'in') { lastIn = r.observed_at; if (!firstUnanswered) firstUnanswered = r.observed_at; }
    else if (dir === 'out') { lastOut = r.observed_at; firstUnanswered = null; }
  }
  // Owed since the FIRST message they sent after our last one: three nudges in a row have been
  // waiting since the first.
  return { owed_since: firstUnanswered, last_inbound_at: lastIn, last_outbound_at: lastOut };
}

/**
 * Batch: entity id → replyOwedFromTouches, over the last `days` of touches.
 * System read (no viewer): direction and time only, never content.
 */
export async function loadReplyOwed(supabase, workspaceId, entityIds, { days = 30 } = {}) {
  const out = new Map();
  const ids = [...new Set((entityIds || []).filter(Boolean))];
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    const { data, error } = await supabase.from('observations')
      .select('entity_id, property, observed_at, is_outbound:raw->is_outbound')
      .eq('workspace_id', workspaceId).in('entity_id', slice)
      .in('property', REPLY_TOUCH_PROPERTIES).gte('observed_at', since)
      .order('observed_at', { ascending: false }).range(0, 999);
    if (error) continue;   // unknown → nothing marked owed; a missed nudge beats a false one
    const byEntity = new Map();
    for (const r of data || []) {
      if (!byEntity.has(r.entity_id)) byEntity.set(r.entity_id, []);
      byEntity.get(r.entity_id).push(r);
    }
    for (const id of slice) out.set(id, replyOwedFromTouches(byEntity.get(id) || []));
  }
  return out;
}
