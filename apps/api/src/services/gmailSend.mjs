// Sending an approved email from the seat's own Gmail (GET-731). Kept out of gmailDraft.mjs, which
// only ever drafts: this is reached only from Approvals, after a person reviewed (and maybe edited)
// the email and pressed Send. Same connection rules as the draft: the chosen mailbox, else the
// person's own, never a colleague's.
import { draftArguments, withGmail } from './gmailDraft.mjs';

/**
 * Send an email from the seat's own Gmail (GET-731). Only ever after a person approved it in
 * Approvals, with their edits: the review's Send, never an automation on its own.
 * @returns {Promise<{ status: 'sent', id, mailbox } | { status: 'no_gmail' } | { status: 'failed', error, message }>}
 */
export async function sendGmailEmail(supabase, { workspaceId, userId, to, cc = null, subject, body, execute = null, connectionId = null }) {
  const args = draftArguments({ to, cc, subject, body });
  if (!args.recipient_email) return { status: 'failed', error: 'no_recipient', message: 'Add who it goes to.' };
  return withGmail(supabase, { workspaceId, userId, execute, connectionId }, async (run, conn) => {
    const res = await run('GMAIL_SEND_EMAIL', {
      userId: String(conn.owner_user_id ?? userId ?? ''),
      connectedAccountId: conn.composio_connection_id,
      arguments: args,
    });
    if (res?.successful === false || res?.error) {
      return { status: 'failed', error: 'gmail_rejected', message: String(res?.error || res?.data?.message || 'Gmail rejected the send').slice(0, 200) };
    }
    const d = res?.data?.response_data ?? res?.data ?? {};
    return { status: 'sent', id: d?.id ?? null, mailbox: conn.account_email ?? null };
  });
}

/** Remove a draft that was just sent in its edited form, so it is not sent twice. Best effort. */
export async function deleteGmailDraft(supabase, { workspaceId, userId, draftId, execute = null, connectionId = null }) {
  if (!draftId) return { status: 'skipped' };
  return withGmail(supabase, { workspaceId, userId, execute, connectionId }, async (run, conn) => {
    const res = await run('GMAIL_DELETE_DRAFT', {
      userId: String(conn.owner_user_id ?? userId ?? ''),
      connectedAccountId: conn.composio_connection_id,
      arguments: { draft_id: String(draftId) },
    });
    return res?.successful === false || res?.error ? { status: 'failed', error: 'gmail_rejected' } : { status: 'deleted' };
  });
}
