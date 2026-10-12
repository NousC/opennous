// Executing an approved action.
//
// The only place in the codebase where a message the AGENT wrote leaves the
// building — and it is reachable from exactly one caller: a human clicking
// Approve. See routes/api/actions.mjs.
//
// It also RECORDS the send. A message that goes out and never lands on the record
// is worse than not sending it: the next agent reads a cold account, briefs you as
// though you'd never reached out, and you follow up twice.
//
// Email goes through the operator's own Gmail, here. LinkedIn goes through Unipile, which is
// Cloud's: cloud/services/linkedinSend.mjs registers it at boot (GET-754). Without it, a
// LinkedIn draft fails to send with a message saying so, and stays actionable.

const senders = {};

/** Cloud registers a sender per channel ('linkedin') at boot. */
export function registerActionSender(channel, fn) { senders[channel] = fn; }

/** Send an approved action, then write it back to the graph. Email goes through the
 *  operator's own Gmail; LinkedIn through Unipile. One caller: a human clicking Send. */
export async function sendProposedAction(supabase, action) {
  if (action.kind === 'email') return sendProposedEmail(supabase, action);
  const send = senders.linkedin;
  if (!send) throw new Error('LinkedIn sending is not available on this install.');
  return send(supabase, action);
}

/** Send an approved email through the operator's connected Gmail (gmail.send). */
async function sendProposedEmail(supabase, action) {
  const { workspace_id: workspaceId, recipient_email, subject, body, entity_id, connection_id = null } = action;
  if (!recipient_email) throw new Error('No recipient email on this draft.');

  // The operator's own Gmail — COMPOSIO ONLY. Every pre-Composio `native` connection in
  // production is dead (all four fail refresh with invalid_client: the OAuth client that
  // issued those tokens is not the one configured now), and because they are the only
  // VERIFIED rows they shadowed the Composio ones — so an approved send failed with
  // invalid_client instead of saying "connect Gmail". Removing the branch removes nothing
  // that worked.
  const { data: conn } = await supabase
    .from('workflow_provider_connections')
    .select('id, account_email, owner_user_id, composio_connection_id, workflow_providers!inner(name)')
    .eq('workspace_id', workspaceId)
    .eq('is_verified', true)
    .eq('workflow_providers.name', 'gmail_oauth')
    .eq('managed_by', 'composio')
    .not('composio_connection_id', 'is', null)
    // The mailbox the approver chose or owns (GET-745); the workspace's newest only when neither is known.
    .match(connection_id ? { id: connection_id } : {})
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conn) throw new Error('Gmail is not connected for this workspace. Connect Gmail in Integrations to send email.');

  const { loadComposioConfig, getComposioClient } = await import('../providers/composio.mjs');
  const cfg = await loadComposioConfig(supabase, workspaceId);
  if (!cfg?.apiKey) throw new Error('Composio is not configured for this workspace, so the approved email cannot be sent.');
  const composio = getComposioClient(cfg.apiKey, cfg.baseUrl);
  const res = await composio.tools.execute('GMAIL_SEND_EMAIL', {
    userId: String(conn.owner_user_id ?? ''),
    connectedAccountId: conn.composio_connection_id,
    arguments: { recipient_email, subject: subject || '', body: body || '', is_html: false },
  });
  if (res?.successful === false || res?.error) {
    throw new Error(`Gmail rejected the send: ${String(res?.error || res?.data?.message || 'unknown error').slice(0, 200)}`);
  }
  const outMsg = res?.data || res?.response_data || {};
  const sent = { id: outMsg.id ?? outMsg.messageId ?? null, threadId: outMsg.threadId ?? outMsg.thread_id ?? null };

  // Onto the record, so the next brief knows the follow-up went out and what it said.
  if (entity_id) {
    await supabase.from('observations').insert({
      workspace_id: workspaceId,
      entity_id,
      kind: 'event',
      property: 'interaction.email_sent',
      value: { subject: subject || null, text: body, to: recipient_email, sent_by: 'agent', approved: true },
      // Decision link — trace this send back to the rec that prompted it.
      raw: { rec_id: action.rec_id ?? null, action_id: action.id ?? null },
      source: 'gmail',
      method: 'agent_send',
      observed_at: new Date().toISOString(),
    }).then(() => {}, err => {
      console.error('[emailSend] sent, but failed to record:', err.message);
    });
  }

  return { provider: 'gmail', id: sent.id, thread_id: sent.threadId, to: recipient_email };
}
