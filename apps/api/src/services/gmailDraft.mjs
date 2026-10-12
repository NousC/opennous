// A follow-up email as a DRAFT in the approver's own Gmail (workspace redesign Phase 4).
//
// The follow-up card drafts the email; the rep sends it. "Sync to HubSpot" puts the approved
// email into the approver's Drafts folder, so sending it is one click in Gmail, from their own
// address, in their own thread history. It is never sent from here: the only send path in the
// API is linkedinSend.mjs's sendProposedEmail, behind its own Approve.
//
// Same plumbing as that send: Composio, the seat's own connection (owner_user_id), the toolkit
// version pinned in providers/composio.mjs. THE APPROVER'S OWN MAILBOX ONLY, never a colleague's
// and never a shared one: a draft is something only its owner should find in their Drafts.

const GMAIL_COLS = 'id, account_email, owner_user_id, composio_connection_id, workflow_providers!inner(name)';

/** The approver's own Composio Gmail connection, or null. */
export async function ownGmailConnection(supabase, workspaceId, userId, connectionId = null) {
  if (!userId && !connectionId) return null;
  let q = supabase
    .from('workflow_provider_connections').select(GMAIL_COLS)
    .eq('workspace_id', workspaceId).eq('is_verified', true)
    .eq('workflow_providers.name', 'gmail_oauth')
    .eq('managed_by', 'composio')
    .not('composio_connection_id', 'is', null);
  // A chosen mailbox (GET-716) wins; otherwise the user's own.
  q = connectionId ? q.eq('id', connectionId) : q.eq('owner_user_id', userId);
  const { data } = await q
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle();
  return data ?? null;
}

/** Composio's GMAIL_CREATE_EMAIL_DRAFT arguments for a plain-text email to a list of people. */
const addresses = (v) => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(','))
  .filter((e) => typeof e === 'string' && e.includes('@')).map((e) => e.trim()))];

export function draftArguments({ to, cc = null, subject, body }) {
  const list = addresses(to);
  const copy = addresses(cc);
  return {
    // recipient_email is optional on a draft; a draft with no recipient is still a draft.
    ...(list[0] ? { recipient_email: list[0] } : {}),
    ...(list.length > 1 ? { extra_recipients: list.slice(1) } : {}),
    ...(copy.length ? { cc: copy } : {}),
    subject: String(subject ?? ''),
    body: String(body ?? ''),
    is_html: false,
  };
}

/** The draft's ids out of Composio's answer, which wraps Gmail's { id, message: { id, threadId } }. */
export function readDraftResponse(res) {
  const d = res?.data?.response_data ?? res?.response_data ?? res?.data ?? {};
  const draft = d?.draft ?? d;
  const id = draft?.id ?? draft?.draft_id ?? draft?.draftId ?? null;
  const messageId = draft?.message?.id ?? draft?.message_id ?? draft?.messageId ?? null;
  return { id: id ? String(id) : null, message_id: messageId ? String(messageId) : null };
}

/** Where the rep finds it: the mailbox's Drafts, opened on this draft when Gmail gave its message id. */
export function draftUrl(mailbox, messageId) {
  const who = mailbox ? encodeURIComponent(mailbox) : '0';
  return `https://mail.google.com/mail/u/${who}/#drafts${messageId ? `?compose=${encodeURIComponent(messageId)}` : ''}`;
}

/**
 * Create the draft.
 * @returns {Promise<{ status: 'created', id, message_id, url, mailbox } | { status: 'no_gmail' } | { status: 'failed', error, message }>}
 * `execute` is injectable for tests: (slug, { userId, connectedAccountId, arguments }) => Composio's answer.
 */
export async function createFollowUpDraft(supabase, { workspaceId, userId, to, cc = null, subject, body, execute = null, connectionId = null }) {
  return withGmail(supabase, { workspaceId, userId, execute, connectionId }, async (run, conn) => {
    const res = await run('GMAIL_CREATE_EMAIL_DRAFT', {
      userId: String(conn.owner_user_id ?? userId ?? ''),
      connectedAccountId: conn.composio_connection_id,
      arguments: draftArguments({ to, cc, subject, body }),
    });
    if (res?.successful === false || res?.error) {
      return { status: 'failed', error: 'gmail_rejected', message: String(res?.error || res?.data?.message || 'Gmail rejected the draft').slice(0, 200) };
    }
    const { id, message_id } = readDraftResponse(res);
    return { status: 'created', id, message_id, url: draftUrl(conn.account_email ?? null, message_id), mailbox: conn.account_email ?? null };
  });
}

/** The seat's Gmail connection and a Composio runner for it, with one way of saying what went wrong. */
export async function withGmail(supabase, { workspaceId, userId, execute, connectionId }, fn) {
  const conn = await ownGmailConnection(supabase, workspaceId, userId, connectionId);
  if (!conn) return { status: 'no_gmail' };
  let run = execute;
  if (!run) {
    const { loadComposioConfig, getComposioClient } = await import('../providers/composio.mjs');
    const cfg = await loadComposioConfig(supabase, workspaceId);
    if (!cfg?.apiKey) return { status: 'failed', error: 'composio_not_configured', message: 'Gmail is connected through Composio, which is not configured here.' };
    const composio = getComposioClient(cfg.apiKey, cfg.baseUrl);
    run = (slug, args) => composio.tools.execute(slug, args);
  }
  try {
    return await fn(run, conn);
  } catch (err) {
    // An expired or revoked connection says so (GET-719): it still reads as connected on our side,
    // and "error executing the tool" sent nobody to reconnect it.
    const detail = JSON.stringify(err?.cause ?? err?.response?.data ?? {});
    if (/EXPIRED|ConnectedAccountExpired|"status":410|INACTIVE/i.test(`${detail} ${err?.message ?? ''}`)) {
      return { status: 'failed', error: 'expired', message: `The Gmail connection ${conn.account_email ?? ''} expired. Reconnect Gmail in Integrations.`.replace('  ', ' ') };
    }
    return { status: 'failed', error: 'gmail_failed', message: String(err?.userMessage || err?.message || err).slice(0, 200) };
  }
}
