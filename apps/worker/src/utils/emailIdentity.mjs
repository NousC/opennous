// What an email IS, independent of whose mailbox it was read from (GET-244, GET-245).
//
// Gmail gives every mailbox its own message id and thread id for the same email. Two founders
// on one thread therefore filed every message twice — once per mailbox — and nothing could say
// who was actually on an email, because the list call returns `to` but never `cc`. The RFC 2822
// headers answer both: `Message-ID` is the same in every copy, and `From`/`To`/`Cc` are the
// participants. Verified against a production thread.
//
// Pure functions, no I/O — the fetch lives in handlers/gmailBody.mjs.

import { createHash } from 'node:crypto';
import { machineSenderReason, isRoleInbox } from '@nous/core';

// In @nous/core since GET-1087, beside the thread rules that use them.
export { machineSenderReason, isRoleInbox };

const EMAIL_RE = /[^\s<>"',;()]+@[^\s<>"',;()]+\.[^\s<>"',;()]+/g;

/** Every address in a header value, lowercased, in order, deduped. */
export function addressesIn(value) {
  const found = String(value ?? '').match(EMAIL_RE) || [];
  return [...new Set(found.map(a => a.toLowerCase().replace(/[.>]+$/, '')))];
}

/** A header from a Gmail `payload.headers` array (case-insensitive), or null. */
export function header(headers, name) {
  const n = String(name).toLowerCase();
  return (Array.isArray(headers) ? headers : []).find(h => String(h?.name).toLowerCase() === n)?.value ?? null;
}

/** `<abc@mail.gmail.com>` → `abc@mail.gmail.com`. Null when absent. */
export function normalizeMessageId(value) {
  const v = String(value ?? '').trim().replace(/^<|>$/g, '').trim().toLowerCase();
  return v || null;
}

/** The headers we use, from a `payload.headers` array. */
export function parseEmailHeaders(headers) {
  return {
    rfcMessageId: normalizeMessageId(header(headers, 'Message-ID')),
    from: addressesIn(header(headers, 'From'))[0] ?? null,
    to: addressesIn(header(headers, 'To')),
    cc: addressesIn(header(headers, 'Cc')),
    inReplyTo: normalizeMessageId(header(headers, 'In-Reply-To')),
    references: String(header(headers, 'References') ?? '').trim() || null,
    listUnsubscribe: header(headers, 'List-Unsubscribe'),
    listId: header(headers, 'List-Id'),
    precedence: String(header(headers, 'Precedence') ?? '').toLowerCase() || null,
    autoSubmitted: String(header(headers, 'Auto-Submitted') ?? '').toLowerCase() || null,
  };
}

/**
 * The observation external id for one email on one person. Keyed on the RFC Message-ID when we
 * have it, so the same email read from a second mailbox collides with the first instead of
 * filing a duplicate; the per-mailbox Gmail id otherwise (the shape every row had before).
 */
export function emailExternalId({ rfcMessageId, gmailMessageId, contactId }) {
  if (rfcMessageId) {
    const h = createHash('sha1').update(rfcMessageId).digest('hex').slice(0, 20);
    return `gmail_rfc_${h}_${contactId}`;
  }
  return `gmail_${gmailMessageId}_${contactId}`;
}

const NOREPLY_RE = /(^|[._+-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounce|newsletter|marketing|news|updates?|digest)([._+-]|@)/i;

/**
 * Mail sent to many, by a machine or a list — a newsletter, a notification, an autoresponder.
 * Never a reply to our outreach, so never a reply label and never a suppression.
 */
export function isBulkEmail(h, fromAddr) {
  if (h?.listUnsubscribe || h?.listId) return true;
  if (h?.precedence && /^(bulk|list|junk)$/.test(h.precedence)) return true;
  if (h?.autoSubmitted && h.autoSubmitted !== 'no') return true;
  const from = String(fromAddr || h?.from || '');
  if (machineSenderReason(from)) return true;
  return NOREPLY_RE.test(from.split('@')[0] + '@');
}

/** True when the email says it answers another one (In-Reply-To or References). */
export function isReply(h) {
  return Boolean(h?.inReplyTo || h?.references);
}

/**
 * Who may read an email's content: its participants and every member whose mailbox holds a copy.
 * Stored on the observation so the read side needs no mailbox access to decide.
 */
export function participantsOf(h, fallback = {}) {
  const from = h?.from || fallback.from || null;
  const to = h?.to?.length ? h.to : (fallback.to || []);
  const cc = h?.cc?.length ? h.cc : (fallback.cc || []);
  return { from, to, cc };
}
