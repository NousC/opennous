// Email arrives as messages. Noema reads THREADS (GET-329).
//
// WHY. Email is elliptical. "Fine by me, Thursday the 9th then" read on its own yields nothing, or
// an invention. Read under the message it answers it is a confirmed pilot date. A message-unit read
// of a reply corpus does not produce thinner claims — it produces WRONG ones.
//
// It also dissolves the fan-out: a large inbox holds noticeably more inbound rows than distinct emails,
// because each is stored once per associated contact. Extract per thread and file each claim against
// the person it names, and the overpay and the near-identical duplicate claims go together.
//
// Everything here except loadEmailThreads is PURE, so the rule that decides what thousands of paid model
// calls will read can be tested without a database, the way selectBackfillUnits already is.

import { loadOwnDomains, isOwnEmail } from '@nous/core';
import { machineSenderReason, isRoleInbox } from '../utils/emailIdentity.mjs';

const SENT = 'interaction.email_sent';

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

// A body line that looks like a side header would let a correspondent forge attribution — write
// "--- us · someone ---" into an email and the text under it reads as ours, or worse, a sentence of
// ours reads as theirs and becomes their evidence. The corpus is untrusted input; neutralise it.
const HEADER_LIKE = /^---\s*(us|them)\s*·.*---\s*$/gim;
export const stripHeaderLines = (body) => String(body ?? '').replace(HEADER_LIKE, '[line removed]');

/** `2026-09-16`, the day it was sent. */
const dayOf = (at) => (at ? new Date(at).toISOString().slice(0, 10) : 'undated');

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

/**
 * The month a thread BELONGS to: the month of its last message.
 *
 * A cohort is chosen this way rather than by windowing the message scan, and the difference is the
 * whole point. Windowing the scan to August would assemble an August-to-September conversation from
 * its August half only — the same truncation the keyset paging work removed, reintroduced through
 * the front door. So the scan stays whole and only the SELECTION is by month: every thread is
 * assembled from all of its messages, and lands in exactly one cohort.
 *
 * Last message rather than first, for the same reason the age policy uses it: a thread opened in
 * March and still running in September is September's conversation, not March's.
 */
export function threadMonth(thread) {
  const at = lastAt(thread);
  return at ? String(at).slice(0, 7) : null;
}

/**
 * The thread as the model reads it: one header line per message, then what was written.
 *
 * The header is what `theirSideOf` in grounding.mjs splits on, so a claim about the customer can be
 * grounded on their messages alone while the model still reads both sides. Changing this format
 * means changing SIDE_HEADER with it — twoSidedGrounding.test.mjs is what catches that.
 */
export function renderThread(thread) {
  return thread.messages
    .map(m => `--- ${m.side} · ${m.from ?? 'unknown'} · ${dayOf(m.observedAt)} ---\n${stripHeaderLines(m.body).trim()}`)
    .join('\n\n');
}

// ── loading ───────────────────────────────────────────────────────────────────

const PAGE = 1000;   // PostgREST caps every response at 1000 rows, silently

// The LIGHT scan pages smaller than everything else, and the reason is the statement timeout.
//
// Pass 1 reads six fields out of `raw`, and `raw` holds the email body — up to 20,000 characters.
// Postgres has to detoast the whole blob to read `thread_id` out of it, so a 1,000-row page costs
// over a second whatever the index does. Across a hundred-plus pages that is minutes of continuous querying,
// and a single page spiking past PostgREST's 8s ceiling kills the entire run. The same scan
// survived that gauntlet one morning and died three times the same evening: same code, same
// corpus, different luck.
//
// 250 rows costs about a quarter of that, so a page now has to run ~20x slower than normal to time out
// instead of ~6x. Same total work, four times the round trips, and a margin that does not depend on the day.
//
// THE DURABLE FIX IS NOT THIS. It is to stop reading `raw` in pass 1 at all — a generated
// thread_id column, or the light fields promoted out of the blob — so the scan never detoasts a
// body it is not going to read. This buys the runs until that exists.
const LIGHT_PAGE = 250;

// KEYSET on observed_at alone, because that is the only form the index can serve.
//
// The first attempt used the correct tuple cursor — `observed_at < X OR (observed_at = X AND
// id < Y)` — and it did not work. PostgREST turns that OR into a FILTER rather than an index
// condition, so the scan walked the index from the beginning discarding rows until it reached the
// cursor. Measured at the halfway point: tens of thousands of rows removed by filter, over ten seconds. The same O(n)
// walk as OFFSET wearing different syntax, which is why the unbounded scan still died.
//
//   observed_at < X OR (observed_at = X AND id < Y)   Filter,    ~10,000 ms, ~60,000 buffers
//   observed_at <= X                                  Index Cond,     ~5 ms,  ~1,000 buffers
//
// So the cursor is observed_at alone, INCLUSIVE. Inclusive repeats the rows sharing the boundary
// timestamp and those repeats are removed here by id — deliberately the safe direction, because
// exclusive SKIPS them and a skipped row is a thread quietly missing a message.
//
// The one case this cannot absorb is a single timestamp shared by more rows than a page holds: the
// cursor stops moving. That is detected rather than looped on, and stepping strictly past it loses
// the rows beyond the page at that instant — so it says so, loudly, because a silent loss here is
// indistinguishable from a quiet corpus.
async function keysetAll(makeQuery, max = Infinity, pageSize = PAGE) {
  const rows = [];
  const seenIds = new Set();
  let cursor = null;
  let strict = false;
  while (rows.length < max) {
    const want = Math.min(pageSize, max - rows.length);
    const { data, error } = await makeQuery(cursor, want, strict);
    if (error) throw error;
    const page = data ?? [];
    const fresh = page.filter(r => !seenIds.has(r.id));
    for (const r of fresh) seenIds.add(r.id);
    rows.push(...fresh);
    if (page.length < want) break;
    if (fresh.length === 0) {
      console.warn(`[EMAIL_SCAN] more than ${pageSize} rows share ${cursor}; stepping past it — rows at that exact timestamp beyond the page are NOT read`);
      strict = true;
    } else {
      strict = false;
    }
    cursor = page[page.length - 1].observed_at;
  }
  return rows;
}

/**
 * Two passes, because the bodies are the expensive part.
 *
 * `backfillExtraction.mjs` selects `raw` for every row, which in a large inbox is a very large number of emails
 * with bodies up to 20,000 characters each — gigabytes into Node to decide that a few thousand threads
 * are worth reading. So pass 1 pulls only what the RULES need (who, when, which thread) and pass 2 fetches
 * bodies for the threads that survived.
 *
 * `maxMessages` bounds the scan, newest first, and is now a CHOICE rather than a necessity: with
 * keyset paging an unbounded walk costs the same per page at the end as at the start. It still
 * truncates threads at its boundary, so a full backfill passes 0 and a sample passes a number.
 *
 * This fixes the client side, not the database's. `thread_id` lives inside the jsonb `raw` blob with
 * no index on it, so the scan and the detoast still happen server-side; a generated column plus an
 * index on (workspace_id, thread_id) is what would fix that, and is worth doing separately.
 */
export async function loadEmailThreads(supabase, workspaceId, { since = null, maxMessages = Infinity, properties = ['interaction.email_received', SENT] } = {}) {
  const ownDomains = await loadOwnDomains(supabase, workspaceId);

  // ONE PROPERTY PER QUERY, ordered by observed_at alone. Measured on the real corpus:
  //
  //   property IN (received, sent) + ORDER BY observed_at DESC, id   ~20,000 ms   ~400,000 buffers
  //   property = received          + ORDER BY observed_at DESC           ~400 ms     ~3,000 buffers
  //
  // `idx_observations_ws_property` is (workspace_id, property, observed_at DESC). An equality on
  // property lets the index supply the ordering directly, so the scan stops at the page size and
  // detoasts 1,000 jsonb blobs. Two property values, or an `id` tiebreak, force a Gather Merge and
  // a sort — which must first project and detoast every one of the tens of thousands of matching rows to return 1,000 of them,
  // roughly 3GB of buffers, and blows the statement timeout before the run reads anything.
  //
  // TIE CAVEAT: observed_at is not unique (an import stamps rows from the source clock), and
  // offset paging over a non-unique sort key can repeat or skip a row across page boundaries.
  // Repeats are absorbed below by id; skips are not, so a FULL backfill wants a keyset on
  // (observed_at, id) with an index to match, or the thread_id generated column. For a bounded
  // sample this is the right trade against not being able to read at all.
  const perProperty = await Promise.all(properties.map(prop => keysetAll((cursor, want, strict) => {
    let q = supabase.from('observations')
      .select('id, entity_id, property, observed_at, threadId:raw->>thread_id, from:raw->>from, to:raw->>to, subject:value->>description, dedupKey:raw->>hubspot_id, isOutbound:raw->>is_outbound')
      .eq('workspace_id', workspaceId).eq('property', prop);
    if (since) q = q.gte('observed_at', since);
    // Inclusive, so no row at the boundary instant is skipped; the duplicates that causes are
    // removed by id in keysetAll. `strict` is only for a timestamp cluster wider than one page.
    if (cursor) q = strict ? q.lt('observed_at', cursor) : q.lte('observed_at', cursor);
    return q.order('observed_at', { ascending: false }).limit(want);
  }, maxMessages, LIGHT_PAGE)));

  const seen = new Set();
  const light = perProperty.flat().filter(r => !seen.has(r.id) && seen.add(r.id));

  const messages = light.map(r => ({
    id: r.id, entityId: r.entity_id, property: r.property, observedAt: r.observed_at,
    threadId: r.threadId, from: r.from, to: r.to, subject: r.subject, dedupKey: r.dedupKey,
    raw: { is_outbound: r.isOutbound === 'true' },
  }));

  return { threads: groupIntoThreads(messages, ownDomains), ownDomains, scanned: messages.length };
}

// PostgREST puts an `in` list in the QUERY STRING, so a chunk of ids is a chunk of URL. At 1,000
// UUIDs that is roughly 40KB of request line against undici's ~16KB header limit, and the request
// dies with HeadersOverflowError before it reaches the database. 100 keeps it near 4KB.
//
// This is a bug that only exists at scale: 30 threads carried few enough message ids to fit, so two
// samples and an apply run passed over it, and it appeared the first time a real cohort was read.
const ID_CHUNK = 100;

/** Fill in the bodies for the threads that were selected — and only those. */
export async function hydrateThreadBodies(supabase, workspaceId, units) {
  const ids = units.flatMap(u => u.messages.map(m => m.id));
  const byId = new Map();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await supabase.from('observations')
      .select('id, body:raw->>text').eq('workspace_id', workspaceId).in('id', ids.slice(i, i + ID_CHUNK));
    if (error) throw error;
    for (const row of data ?? []) byId.set(row.id, row.body ?? '');
  }
  for (const unit of units) {
    for (const m of unit.messages) m.body = byId.get(m.id) ?? '';
    unit.chars = unit.messages.reduce((n, m) => n + m.body.length, 0);
  }
  return units;
}
