// Which email threads get read, and why the rest do not (GET-329). Moved here from the worker in
// GET-1087 so the api's plan-fit counts exactly what the reader would read: one list of rules.
// Everything here is pure.

import { isOwnEmail } from '../db/workspaceDomains.js';

const SENT = 'interaction.email_sent';

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

// A thread is only worth a model call if there is something in it to read. Below this it is
// "thanks!", an out-of-office, or a subject with an empty body.
export const MIN_THREAD_CHARS = 400;

/** `Re: Fwd: RE: Networking call` → `networking call`. */
export function normalizeSubject(subject) {
  return String(subject ?? '')
    .replace(/^(\s*(re|fw|fwd|aw|tr)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * What identifies the conversation this message belongs to.
 *
 * HubSpot gives most rows a thread_id. A few thousand in a large inbox have none, and dropping those would lose
 * real conversations, so they fall back to the pair (normalised subject, counterpart) — the same
 * two things a person uses to say "this is the same email chain". A subject with no counterpart is
 * not enough on its own: "Re: Introduction" would collapse every unrelated intro into one thread.
 */
export function threadKeyOf(msg) {
  if (msg?.threadId) return `tid:${msg.threadId}`;
  const subject = normalizeSubject(msg?.subject);
  const counterpart = msg?.side === 'us' ? msg?.to : msg?.from;
  if (!subject || !counterpart) return null;
  return `subj:${subject}|${String(counterpart).toLowerCase()}`;
}

/** Which side wrote this. The stored direction decides; the sender's domain is the cross-check. */
export function sideOf(msg, ownDomains) {
  if (msg.property === SENT || msg.raw?.is_outbound === true) return 'us';
  return isOwnEmail(msg.from, ownDomains) ? 'us' : 'them';
}

/**
 * Group messages into threads, deduped.
 *
 * One email associated to three contacts is three rows and ONE message — it is read once, and the
 * entity ids it touched are carried on the thread so its claims can still be filed against each
 * person it names.
 *
 * @param messages light rows: { id, entityId, property, observedAt, threadId, from, to, subject, dedupKey, raw? }
 * @returns {Map<string, { key, messages: [], entityIds: Set }>} messages sorted oldest first
 */
export function groupIntoThreads(messages, ownDomains) {
  const threads = new Map();
  const seen = new Map();                         // dedupKey -> the message we kept

  for (const raw of messages ?? []) {
    const msg = { ...raw, side: sideOf(raw, ownDomains) };
    const dedup = msg.dedupKey || msg.id;
    const kept = seen.get(dedup);
    if (kept) {
      // The duplicate is the SAME email on another contact. Its only new information is that
      // contact, and it has to reach the THREAD as well as the message — the thread's entity set is
      // what decides "is there an external counterpart here" and what the claims get filed against.
      if (msg.entityId) { kept.entry.entityIds.add(msg.entityId); kept.thread.entityIds.add(msg.entityId); }
      continue;
    }

    const key = threadKeyOf(msg);
    if (!key) continue;                           // no thread_id and no subject: nothing to group on
    if (!threads.has(key)) threads.set(key, { key, messages: [], entityIds: new Set() });
    const thread = threads.get(key);
    const entry = { ...msg, entityIds: new Set(msg.entityId ? [msg.entityId] : []) };
    thread.messages.push(entry);
    if (msg.entityId) thread.entityIds.add(msg.entityId);
    seen.set(dedup, { entry, thread });
  }

  for (const thread of threads.values()) {
    thread.messages.sort((a, b) => String(a.observedAt).localeCompare(String(b.observedAt)));
  }
  return threads;
}

/**
 * Which threads are worth reading, and why the rest are not.
 *
 * The ordered rules from the Gmail brief §5–§6. All deterministic; none needs a model, and each
 * one has a named skip reason so a run's own output says where the corpus went.
 */
export function selectEmailThreads({ threads, externalIds, extractedIds = new Set() }) {
  const skipped = {};
  // Which thread was skipped and why, beside the counts — the daily reader records it so the
  // Activity page can show it (GET-503).
  const skippedThreads = [];
  let current = null;
  const skip = (why) => { skipped[why] = (skipped[why] ?? 0) + 1; skippedThreads.push({ thread: current, why }); };
  const units = [];

  for (const thread of threads.values()) {
    current = thread;
    const machine = thread.messages.map(m => machineSenderReason(m.from)).find(Boolean);
    if (machine) { skip(machine === 'relay' ? 'relayed from a source we already hold' : 'machine sender'); continue; }

    // A shared desk is not a person, and the sample proved this is a data-integrity rule rather
    // than a preference. `support@helpdesk-vendor.example` produced about a third of the facts in an early sample —
    // vendor support-ticket content, filed with an EMAIL ADDRESS as the subject ("support@helpdesk-vendor.example
    // escalates technical questions to its development team"), while the subject guard correctly
    // DROPPED several facts about the support agent, the actual human in the thread, because she is not
    // the contact it is filed against. So the mailbox's statements are kept and the person's are
    // discarded. isRoleInbox existed and was wired to nothing; this is the wiring.
    const role = thread.messages.map(m => m.from).find(f => isRoleInbox(f));
    if (role) { skip('role inbox — no attributable subject'); continue; }

    // Our own cold send that nobody answered is not evidence about them: no reply means they said
    // nothing. Extracting it would file our pitch as a fact about the prospect.
    if (!thread.messages.some(m => m.side === 'them')) { skip('outbound only — they never replied'); continue; }

    const external = [...thread.entityIds].filter(id => externalIds.has(id));
    if (!external.length) { skip('no external counterpart'); continue; }

    if (thread.messages.every(m => extractedIds.has(m.id))) { skip('already has claims'); continue; }

    // "Is there enough here to read" is the one rule that needs the bodies, and the bodies are the
    // thing pass 1 deliberately does not fetch. So it is evaluated only once they are present, and
    // the runner calls this function a SECOND time after hydration. Running it twice is free and
    // keeps one list of rules — a separate post-hydration filter is how the two copies drift.
    const loaded = thread.messages.some(m => typeof m.body === 'string');
    const chars = thread.messages.reduce((n, m) => n + String(m.body ?? '').length, 0);
    if (loaded && chars < MIN_THREAD_CHARS) { skip('nothing to read'); continue; }

    units.push({ ...thread, externalIds: external, chars: loaded ? chars : null });
  }

  units.sort((a, b) => String(lastAt(b)).localeCompare(String(lastAt(a))));   // newest first
  return { units, skipped, skippedThreads };
}

export const lastAt = (thread) => thread.messages[thread.messages.length - 1]?.observedAt ?? null;
