// Fetching the body of a message we only got a snippet of.
//
// The out-of-session edit is the case no prompt can fix: the agent hands over a draft, the
// human rewrites it in Gmail and sends. The agent never sees the final text, so only this
// ingest lane can tell whether the draft survived — and the webhook payload frequently carries
// a snippet rather than the body, which is unusable. Hashing a truncated body would differ
// from the draft every single time and label the whole corpus 'edited'.
//
// So when a send might resolve a real proposal, we go and get the message.
//
// Two deliberate constraints:
//
//   Only when it can pay off. One API call per outbound email is wasteful when most sends have
//   no proposal behind them, so the caller checks for an open proposal first.
//
//   Verify what came back. The action slug and argument shape are not something we can confirm
//   against the live toolkit from here, and composio.mjs already documents a trigger slug that
//   silently did not exist. So we match the returned message id against the one we asked for
//   and discard anything else. A wrong guess then costs a failed lookup, never a wrong hash —
//   which matters, because a wrong hash is indistinguishable from a real edit.

import { googleClientFor, hasGoogleTransport } from '../../utils/googleClient.mjs';
import { parseEmailHeaders } from '../../utils/emailIdentity.mjs';

// The shared worker client (utils/composioClient.mjs) pins the toolkit version. This file used
// to build its own bare client, and tools.execute() throws on the SDK's default 'latest' — so
// every body fetch here failed (found GET-244).

const MATCH_FIELDS = ['messageId', 'message_id', 'id', 'messageTimestamp'];
const BODY_FIELDS = ['messageText', 'message_text', 'body_text', 'text', 'body'];

function pluck(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && v !== '') return v;
  }
  return null;
}

/** Every message-shaped object in whatever envelope Composio returned. */
function candidates(res) {
  const out = res?.data ?? res?.response_data ?? res ?? {};
  const list = out.messages ?? out.items ?? out.data ?? (Array.isArray(out) ? out : [out]);
  return Array.isArray(list) ? list : [list];
}

/**
 * The full text of one sent message, or null.
 *
 * Null is a normal outcome and the caller treats it as such — no hash, confirmation still
 * lands, verdict keeps whatever it had. Failing to verify an edit is a missed lesson; claiming
 * a false one is a wrong number in a dataset we are asking people to trust.
 */
export async function fetchSentBody(supabase, workspaceId, conn, messageId) {
  if (!messageId || !hasGoogleTransport(conn)) return null;
  try {
    const composio = await googleClientFor(supabase, conn);   // Composio, or native Google (GET-765)
    if (!composio) return null;
    // GMAIL_FETCH_EMAILS is the one action we know is live — sourceLookup.mjs drives it today.
    // Reaching for an unverified slug is how the sent-trigger mistake happened.
    const res = await composio.tools.execute('GMAIL_FETCH_EMAILS', {
      userId: String(conn.owner_user_id ?? ''),
      connectedAccountId: conn.composio_connection_id,
      arguments: { query: `rfc822msgid:${messageId}`, max_results: 1 },
    });
    if (res?.successful === false) return null;

    for (const m of candidates(res)) {
      const id = pluck(m, MATCH_FIELDS);
      // The guard. Without it a query that quietly ignored our filter would hand back the most
      // recent message in the mailbox and we would hash somebody else's email.
      if (String(id ?? '') !== String(messageId)) continue;
      const body = pluck(m, BODY_FIELDS);
      if (body) return String(body);
    }
    return null;
  } catch (e) {
    console.warn('[gmail/body] fetch failed, falling back to no hash:', e.message);
    return null;
  }
}

/**
 * Is there anything this fetch could resolve? Keeps us from spending a call per outbound email
 * when most sends have no recommendation behind them.
 */
export async function hasOpenProposalFor(supabase, workspaceId, recipients, windowHours = 6) {
  const list = (recipients ?? []).filter(Boolean).map((r) => String(r).toLowerCase());
  if (!list.length) return false;
  const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
  const { data } = await supabase.from('ri_decisions')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('status', 'proposed')
    .in('recipient', list)
    .gte('created_at', since)
    .limit(1);
  return !!data?.length;
}

/**
 * The RFC headers of one message in one mailbox — Message-ID, From, To, Cc, In-Reply-To,
 * References, List-Unsubscribe — or null. `format: metadata` returns headers without the body.
 * Verified live 2026-09-14: both founders' copies of a shared email carry the same Message-ID
 * and the Cc line the list call never returns (GET-244).
 */
export async function fetchMessageHeaders(supabase, workspaceId, conn, messageId) {
  if (!messageId || !hasGoogleTransport(conn)) return null;
  try {
    const composio = await googleClientFor(supabase, conn);   // Composio, or native Google (GET-765)
    if (!composio) return null;
    const res = await composio.tools.execute('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', {
      userId: String(conn.owner_user_id ?? ''),
      connectedAccountId: conn.composio_connection_id,
      arguments: { message_id: String(messageId), format: 'metadata' },
    });
    if (res?.successful === false) return null;
    const d = res?.data?.response_data ?? res?.data ?? {};
    // Same guard as the body fetch: never trust a message we did not ask for.
    const got = d.messageId ?? d.id ?? null;
    if (got != null && String(got) !== String(messageId)) return null;
    const headers = d.payload?.headers ?? d.headers ?? null;
    if (!Array.isArray(headers) || !headers.length) return null;
    return { ...parseEmailHeaders(headers), gmailThreadId: d.threadId ?? null };
  } catch (e) {
    console.warn('[gmail/headers] fetch failed:', e.message);
    return null;
  }
}
