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

// Senders that are machines whatever their local part says (GET-329).
//
// WHY A LIST AND NOT JUST THE REGEX. The four header checks below decide this correctly for live
// Gmail, and the regex is the fallback for the local part. Neither fires on CRM-IMPORTED mail:
// HubSpot stores from/to/subject/body and no headers at all, and `jira@examplecorp.atlassian.net`
// matches nothing in NOREPLY_RE — it is not a no-reply, a notification or a digest by name. On
// a real corpus that alone can be a great many inbound rows we would have paid to extract facts out of.
//
// TWO REASONS, KEPT APART ON PURPOSE. They look like one list and are not, and someone reading
// only a flat blocklist would eventually "fix" it by letting the relays back in:
//
//   machine — no human voice at any point. An HR notification, a ticket update, a receipt.
//   relay   — a human conversation that BELONGS TO ANOTHER INTEGRATION. The email is a strictly
//             worse copy of it, so reading it files the same meeting or call a second time, from
//             the summary rather than the transcript. Fellow's meetings are the only claims
//             a customer has; its digest emails would double every one of them.
//
// Matched as SUFFIXES, so one entry covers every tenant: `examplecorp.atlassian.net`,
// `examplecorp.intercom-mail.com` and the next client's equivalents all resolve from one line.
//
// ADDING ONE: it belongs here only when EVERY address on the domain is a machine. A domain with
// both `support@` and real named people is NOT this — see isRoleInbox. Add on evidence (a sender
// sweep of a real corpus), never on the strength of recognising the vendor's name.
const MACHINE_DOMAINS = new Map([
  ['atlassian.net',          'machine'],   // ticket notifications
  ['bamboohr.com',           'machine'],   // HR
  ['fyxer.com',              'machine'],   // AI-drafted mail — machine-written, not correspondence
  ['zohosubscriptions.com',  'machine'],   // billing
  ['accounts.google.com',    'machine'],   // account + security notices
  ['fellow.app',             'relay'],     // meetings — the Fellow integration owns these
  ['ringcentral.com',        'relay'],     // calls — the RingCentral integration owns these
  ['justcall.io',            'relay'],     // calls
  ['intercom-mail.com',      'relay'],     // support conversations
]);

/** `a@b.atlassian.net` → the entry for `atlassian.net`. Exact match or dot-suffix, never substring. */
function machineDomainEntry(fromAddr) {
  const domain = String(fromAddr ?? '').toLowerCase().split('@')[1];
  if (!domain) return null;
  for (const [suffix, reason] of MACHINE_DOMAINS) {
    if (domain === suffix || domain.endsWith(`.${suffix}`)) return { suffix, reason };
  }
  return null;
}

/** Why this sender is a machine — 'machine', 'relay', or null when it is not one. */
export function machineSenderReason(fromAddr) {
  return machineDomainEntry(fromAddr)?.reason ?? null;
}

/**
 * Mail sent to many, by a machine or a list — a newsletter, a notification, an autoresponder.
 * Never a reply to our outreach, so never a reply label and never a suppression.
 */
export function isBulkEmail(h, fromAddr) {
  if (h?.listUnsubscribe || h?.listId) return true;
  if (h?.precedence && /^(bulk|list|junk)$/.test(h.precedence)) return true;
  if (h?.autoSubmitted && h.autoSubmitted !== 'no') return true;
  const from = String(fromAddr || h?.from || '');
  if (machineDomainEntry(from)) return true;
  return NOREPLY_RE.test(from.split('@')[0] + '@');
}

// A shared human inbox on a domain that also has real people on it — `support@harborline.example` sits
// beside `marlo.trevane@harborline.example`. Deliberately NOT part of isBulkEmail: this is not bulk, it
// is a person writing from a desk nobody owns, and on a real corpus it is a four-figure row count that may well
// carry real account content.
//
// It gets its own predicate because the call is genuinely open. A claim needs an attributable
// subject and a role inbox has none, so these are poor CLAIM evidence — but they are real
// correspondence, and dropping them is a product decision rather than a filtering one. Callers opt
// in; nothing here decides for them.
const ROLE_LOCAL_RE = /^(support|help|info|contact|sales|billing|accounts?|admin|team|hello|service|.*support|.*service)$/i;

export function isRoleInbox(fromAddr) {
  const local = String(fromAddr ?? '').toLowerCase().split('@')[0];
  return Boolean(local) && ROLE_LOCAL_RE.test(local);
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
