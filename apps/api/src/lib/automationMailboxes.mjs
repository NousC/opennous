// The mailboxes an automation can send from (GET-716): the workspace's Gmail accounts (through
// Composio) and its SMTP mailboxes. Gmail can hold a draft; SMTP cannot, so an SMTP send always waits
// for approval and is sent from here once someone approves it.
import nodemailer from 'nodemailer';
import { decrypt } from '../utils/crypto.mjs';

const plain = (v) => { if (!v) return null; try { return decrypt(v); } catch { return v; } };

/** [{ id, kind: 'gmail' | 'smtp', email, owner_user_id }] — verified connections only. */
export async function listMailboxes(supabase, workspaceId) {
  const { data } = await supabase.from('workflow_provider_connections')
    .select('id, account_email, owner_user_id, managed_by, composio_connection_id, is_verified, encrypted_credentials, workflow_providers!inner(name)')
    .eq('workspace_id', workspaceId).eq('is_verified', true)
    .in('workflow_providers.name', ['gmail_oauth', 'smtp']);
  const out = [];
  for (const c of data ?? []) {
    const provider = c.workflow_providers?.name;
    if (provider === 'gmail_oauth' && c.managed_by === 'composio' && c.composio_connection_id) {
      out.push({ id: c.id, kind: 'gmail', email: c.account_email ?? null, owner_user_id: c.owner_user_id ?? null });
    } else if (provider === 'smtp') {
      const raw = c.encrypted_credentials ?? {};
      const email = plain(raw.from_email) || plain(raw.email) || plain(raw.username);
      out.push({ id: c.id, kind: 'smtp', email: email ?? null, owner_user_id: c.owner_user_id ?? null });
    }
  }
  return out;
}

/** Send one plain-text email from an SMTP mailbox of this workspace. { ok, messageId?, reason? } */
export async function sendFromSmtp({ supabase, workspaceId, connectionId, to, cc = null, subject, body }) {
  const list = String(to ?? '').split(',').map(x => x.trim()).filter(x => x.includes('@'));
  if (!list.length) return { ok: false, reason: 'smtp_no_recipient' };
  const { data: c } = await supabase.from('workflow_provider_connections')
    .select('id, encrypted_credentials, workflow_providers!inner(name)')
    .eq('workspace_id', workspaceId).eq('id', connectionId).eq('workflow_providers.name', 'smtp').maybeSingle();
  if (!c) return { ok: false, reason: 'smtp_not_connected' };
  const raw = c.encrypted_credentials ?? {};
  const host = plain(raw.host), username = plain(raw.username), password = plain(raw.password);
  const port = Number(plain(raw.port) || 587);
  if (!host || !username || !password) return { ok: false, reason: 'smtp_not_connected' };
  const from = plain(raw.from_email) || plain(raw.email) || username;
  try {
    const t = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user: username, pass: password } });
    const copy = String(cc ?? '').split(',').map(x => x.trim()).filter(x => x.includes('@'));
    const info = await t.sendMail({ from, to: list.join(', '), ...(copy.length ? { cc: copy.join(', ') } : {}), subject: String(subject ?? ''), text: String(body ?? '') });
    return { ok: true, messageId: info?.messageId ?? null, from };
  } catch (err) {
    return { ok: false, reason: `smtp_failed: ${String(err?.message ?? err).slice(0, 160)}` };
  }
}

/**
 * The mailboxes a person may send from when they approve an email (GET-745): their own connected
 * Gmail accounts, newest first. Never a colleague's: a chosen mailbox is checked against this list.
 * @returns {Promise<{ id, kind: 'gmail', email }[]>}
 */
export async function sendableMailboxes(supabase, workspaceId, userId) {
  if (!userId) return [];
  const all = await listMailboxes(supabase, workspaceId);
  return all.filter((m) => m.kind === 'gmail' && m.owner_user_id === userId).map(({ id, kind, email }) => ({ id, kind, email }));
}

/** A chosen mailbox id, if this person may send from it; else null (the default is used). */
export async function chosenMailbox(supabase, workspaceId, userId, id) {
  if (!id) return null;
  const mine = await sendableMailboxes(supabase, workspaceId, userId);
  return mine.find((m) => m.id === id) ?? false;
}
