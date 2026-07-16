// Executing an approved action.
//
// The only place in the codebase where a message the AGENT wrote leaves the
// building — and it is reachable from exactly one caller: a human clicking
// Approve. See routes/api/actions.mjs.
//
// It also RECORDS the send. A message that goes out and never lands on the record
// is worse than not sending it: the next agent reads a cold account, briefs you as
// though you'd never reached out, and you follow up twice.

import {
  sendLinkedInMessage, sendConnectionRequest, resolveLinkedInMemberId,
} from './linkedin.mjs';

/** Send an approved action through Unipile, then write it back to the graph. */
export async function sendProposedAction(supabase, action) {
  const { workspace_id: workspaceId, kind, linkedin_url, body, entity_id } = action;

  const { data: conn } = await supabase
    .from('workspace_linkedin_connections')
    .select('unipile_account_id')
    .eq('workspace_id', workspaceId)
    .order('connected_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conn) throw new Error('LinkedIn is not connected for this workspace.');

  if (!linkedin_url) throw new Error('No LinkedIn URL on this action — nowhere to send it.');

  const memberId = await resolveLinkedInMemberId(supabase, workspaceId, conn.unipile_account_id, {
    linkedinUrl: linkedin_url,
  });

  const result = kind === 'linkedin_invite'
    ? await sendConnectionRequest(conn.unipile_account_id, memberId, body)
    : await sendLinkedInMessage(conn.unipile_account_id, memberId, body);

  // Onto the record, as an observation like any other. The send becomes evidence:
  // the next brief knows you already reached out, and what you said.
  if (entity_id) {
    const property = kind === 'linkedin_invite'
      ? 'interaction.linkedin_invite_sent'
      : 'interaction.linkedin_message_sent';
    await supabase.from('observations').insert({
      workspace_id: workspaceId,
      entity_id,
      kind: 'event',
      property,
      value: { text: body, sent_by: 'agent', approved: true },
      source: 'linkedin',
      method: 'agent_send',
      observed_at: new Date().toISOString(),
    }).then(() => {}, err => {
      // The message HAS gone out. Failing the request now would tell the user it
      // didn't, and they'd send it twice — the worse of the two errors by far.
      console.error('[linkedinSend] sent, but failed to record:', err.message);
    });
  }

  return result ?? {};
}
