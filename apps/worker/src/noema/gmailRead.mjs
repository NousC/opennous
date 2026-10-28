// The Gmail Read — a thread in, claims and commitments out (GET-329, step 4).
//
// This is the only part of the Gmail path that spends money. Everything before it (grouping,
// side labelling, the noise rules) is deterministic and free, and everything it writes goes
// through the guards that already exist rather than new ones.
//
// THE GUARD THAT IS NEW HERE. A transcript has one text; a thread has two. The model reads the
// whole thread — a reply means nothing without the message above it — but a claim about the
// customer may only REST ON the customer's own messages. Otherwise "as you mentioned, your finance
// team needs the export fix", which is US restating THEM, becomes a fact they told us, carrying a
// quote that is verbatim, passes every check, and is attributed to the wrong side. That is the
// email version of the bug that filed calls onto the seller's own employees.
//
// WHERE A COMMITMENT IS FILED, and why not where the brief says. Brief §11 rule 2 says the owner
// decides the entity — ours on the rep, theirs on their record. The shipped path does not do that:
// signals/index.mjs files every email and LinkedIn task on the COUNTERPART, with owner_kind kept
// in the value. That is exactly why those close and meeting ones do not (GET-357): the task and
// the `email_sent` evidence land on the same entity. Filing our promises on the rep would put the
// task where no evidence lives and reproduce that bug in the path meant to fix it. So: counterpart,
// owner_kind in the value.

import { createHash } from 'node:crypto';
import {
  ARCHIVAL_AFTER_DAYS, writesTasks, resolveDuePhrase, dueDateAgreeingWith, getWorkspaceTimezone, recordObservation,
  emptyTaskProvenance, provenanceFromModel, dealForTask, companyOfContact,
  isAutoNotification, AUTO_NOTIFICATION_REASON, notACommitment, saveAboutUsClaims,
} from '@nous/core';
import { read, parseArray, acceptsArray } from './read.mjs';
import { theirSideOf, groundQuote } from './grounding.mjs';
import { renderThread, lastAt } from './emailThreads.mjs';
import { extractFactsFromText, persistFacts, loadSubject, loadPositionsOnFile } from '../signals/index.mjs';
import { extractCallInsights } from '../signals/insights.mjs';
import { screenFeatureRequests } from '../signals/alreadyHave.mjs';
import { loadAccountBrief } from '../signals/accountBrief.mjs';
import { meterLLM } from '../utils/meterLLM.mjs';
import { loadOurSide, tidyFactContent } from '../signals/extractionText.mjs';

const DAY = 86_400_000;

// A marker that fails inside a .catch is a thread that will be bought again, and nothing in the
// run says so. Counted here so a run can report it rather than leaving it in a log line nobody
// greps — the same reason the dedup blindness is counted.
export let markerFailures = 0;
export const resetMarkerFailures = () => { markerFailures = 0; };
export const SOURCE = 'gmail';

/**
 * A stable, readable id for the conversation — what `source://gmail/<id>` points at.
 *
 * The thread_id when there is one. The messages without one are grouped by subject and
 * counterpart, which makes a key too long and too punctuated to read in a URL, so it is hashed.
 * Either way it is DETERMINISTIC: the same thread produces the same ref on every run, which is
 * what makes the resume check work and what stops a re-run buying the corpus twice.
 */
export function threadId(thread) {
  const key = String(thread?.key ?? '');
  if (key.startsWith('tid:')) return key.slice(4);
  return `subj-${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
}

/** What everything this thread produced points back at. */
export const threadSourceRef = (thread) => `source://${SOURCE}/${threadId(thread)}`;

/**
 * Where a person clicks to read the thread a task came from.
 *
 * Only a real Gmail thread id deep-links. The subject-grouped ones are a hash of our own making
 * and point at nothing, so they get no link rather than a broken one — the task row shows the
 * Gmail mark on its own, which is still true. Message-level links live in
 * apps/api/src/routes/api/evidence.mjs; this is the thread a task belongs to.
 */
export function gmailThreadUrl(thread) {
  const id = threadId(thread);
  if (!id || id.startsWith('subj-')) return null;
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}`;
}

/**
 * How much a thread is worth, by age — the email answer to `meetingTreatment`.
 *
 * ANCHORED ON THE LAST MESSAGE, not the first. A thread opened in March and still running in
 * September is a live conversation; dated by its opening message it would be filed as history
 * while the customer is still typing. A meeting happens at a point in time and a thread does not.
 *
 * The cut REUSES `ARCHIVAL_AFTER_DAYS`, which is itself derived from `HEALTH_WINDOW_DAYS` rather
 * than chosen. A separate thread constant would be a second derivation of one value, and the two
 * would drift the first time either moved.
 *
 *   live     — claims and commitments
 *   archival — claims only
 *
 * Claims never expire; that is the whole reason to read an old thread. A commitment does: filing
 * one from a thread that went quiet in March puts a five-month-overdue task in a rep's queue, and
 * enough of those and they turn the feature off.
 */
export function threadTreatment(thread, now = Date.now()) {
  const at = Date.parse(String(lastAt(thread) ?? ''));
  if (!Number.isFinite(at)) return 'live';   // unknown date: pay rather than silently downgrade
  if (at > now) return 'live';
  return (now - at) / DAY > ARCHIVAL_AFTER_DAYS ? 'archival' : 'live';
}


/**
 * THE MARKER THAT SAYS A THREAD WAS READ — written whatever the reading produced.
 *
 * The first version inferred this from claims: a thread was done when claims carried its
 * source_ref. That is wrong in the direction that costs money. In an early sample about a third
 * of the threads read produced no claims: read, paid for, and invisible — and most of those had
 * produced COMMITMENTS, which is real output the marker simply could not see. Every future run
 * re-buys all of them. Across a full corpus at that no-claim rate that is real money re-spent per
 * full pass, with nothing to show that it happened.
 *
 * Brief §12 says the marker must be the artifact the work produces. A Read produces TWO artifacts
 * and sometimes, legitimately, neither — a thread can be read honestly and yield nothing. So the
 * marker is the READING itself, recorded per thread, and it records what came out so a later pass
 * can tell "read, found nothing" from "never read".
 *
 * Deterministic property, so a re-read overwrites rather than accumulating.
 */
/**
 * Whether a thread may be marked read (2026-10-08). A step the model was UNAVAILABLE for — a credit
 * outage, a provider down — holds the marker, so the next run reads the thread again rather than
 * keeping its facts and losing its insights and tasks for good. An unreadable answer does not hold
 * it: re-buying a thread that always confuses the model would cost credits forever. Pure.
 */
export function shouldMarkThreadRead({ insights = null, commitments = null } = {}) {
  return ![insights, commitments].some(s => s && s.ok === false && s.reason === 'unavailable');
}

export async function markThreadRead(supabase, workspaceId, thread, contactId, { facts, commitments, insights, treatment, now }) {
  const value = {
    source_ref: threadSourceRef(thread),
    read_at: new Date(now).toISOString(),
    // The newest message this read saw: what decides the next read, not the clock (GET-961).
    last_message_at: lastAt(thread),
    treatment,
    claims: facts.length,
    commitments: commitments.length,
    insights,
    messages: thread.messages.length,
  };
  const written = await recordObservation(supabase, {
    workspaceId,
    entityId: contactId,
    kind: 'state',
    // ONE property, with the thread in external_id — not `noema.read.gmail_<id>`.
    //
    // A per-thread property makes the lookup a prefix LIKE, and a prefix LIKE on `property` cannot
    // use the btree index under the default collation. Measured: a parallel seq scan, hundreds of
    // thousands of rows filtered, several seconds — to return nothing. Looped by pageAll it blew the statement timeout and
    // killed the run before it read a thread. That is the same mistake diagnosed for `claims`
    // hours earlier and then written into `observations`.
    //
    // Equality on property uses idx_observations_ws_property, and idempotency comes from
    // observations_dedup — UNIQUE (workspace_id, source, external_id) — which is a better guard
    // than a deterministic property string anyway, because the database enforces it.
    property: 'noema.read',
    externalId: `${SOURCE}_${threadId(thread)}`,
    value,
    source: SOURCE,
    method: 'extraction',
    observedAt: new Date(now).toISOString(),
  });
  // A RE-READ MOVES THE MARKER (GET-503). The dedup index turns a second insert into a silent
  // no-op, so a thread read again after a reply kept its FIRST read_at — and the twice-daily
  // reader, which re-reads a thread whose last message is newer than its read, would buy it
  // again on every run for three days. The row is updated in place instead.
  if (!written) await updateMarker(supabase, workspaceId, `${SOURCE}_${threadId(thread)}`, value, now);
}

async function updateMarker(supabase, workspaceId, externalId, value, now) {
  const { error } = await supabase.from('observations')
    .update({ value, observed_at: new Date(now).toISOString() })
    .eq('workspace_id', workspaceId).eq('source', SOURCE).eq('external_id', externalId);
  if (error) console.warn(`[GMAIL] could not move the marker for ${externalId}: ${error.message}`);
}

/**
 * A thread we chose not to read, and why — so the Activity page can say "skipped: automated"
 * instead of a blank that reads as "not done yet", and never bills it. Its own property and id,
 * so it can never block the read marker if the thread later becomes worth reading.
 */
export async function markThreadSkipped(supabase, workspaceId, thread, reason, now = Date.now()) {
  const entityId = [...(thread.entityIds ?? [])][0] ?? thread.messages?.[0]?.entityId ?? null;
  if (!entityId) return;
  const externalId = `${SOURCE}_skip_${threadId(thread)}`;
  const value = { source_ref: threadSourceRef(thread), reason, at: new Date(now).toISOString(), messages: thread.messages.length };
  const written = await recordObservation(supabase, {
    workspaceId, entityId, kind: 'state', property: 'noema.skip', externalId, value,
    source: SOURCE, method: 'extraction', observedAt: new Date(now).toISOString(),
  }).catch(() => null);
  if (!written) await updateMarker(supabase, workspaceId, externalId, value, now);
}

// ── commitments ───────────────────────────────────────────────────────────────

// The bar is deliberately higher than for a claim. A wrong claim on a page is a bad read; a wrong
// task in a rep's queue is wasted work, and a queue full of those gets switched off. Email is
// especially full of sentences shaped like obligations that are not — "I'll get back to you",
// "happy to send more info", "let me check and revert".
function buildCommitmentPrompt({ text, theirName, ourName }) {
  return `Below is one email thread. Messages are labelled "--- us · … ---" (${ourName}) and "--- them · … ---" (${theirName}).

List the CONCRETE commitments made in it — a specific deliverable someone said they would produce, or explicitly asked the other side to produce.

A LIST OF WORK ${theirName} SENDS FOR ${ourName} TO DO IS A SET OF ASKS. "Problems: …", "here's what we need", "to do on your side", a bulleted brief of things to build, fix, set up or change — each item is one commitment owed by ${ourName} ("owner_kind" "user", "stated_by" "them"), even though nobody wrote "please" or "I will". Name the deliverable with the specifics the item gives: "Set up a daily Slack post of the Fernpoint account activity, built from the CRM's daily stats".

NOT a commitment:
- courtesy and pleasantries — "I'll get back to you", "let me check and revert", "happy to send more info", "we'll be in touch"
- anything already described as done
- a vague intention with no deliverable — "we should talk again soon"
- MEETING LOGISTICS. Attending, accepting an invitation, proposing or confirming a time, sending or forwarding an invite, rescheduling, asking who should be on it. The calendar holds the meeting from there and "Propose a better time" is a row nobody can complete. A commitment MADE AT the meeting is a commitment. (This is one of the most common false commitments.) The one exception: someone agreeing to SET UP a next meeting with a day or a purpose that is not on a calendar yet ("I'll book us Friday to walk through the motions") — that is "Book the Friday session with … on the motions" (start the title with "Book").
- A QUESTION THE SENDER ASKED. "How is your team handling after-hours inquiries today?", "Does it sync to Ledgerway?", "Is this a pricing issue?" — a rep's discovery question is not a task for the person who received it. Only an explicit REQUEST for a deliverable counts: "can you send me the invoice", "please remove Tobiah from the system".
- A CALL TO ACTION IN A BULK EMAIL. "RSVP for the webinar", "Review the offer and start verifying", "Book a session with me" — a link in a mass send, ours or a vendor's, is marketing, not a promise anyone made.
- A NUMBERED STEP IN A TEMPLATE. "Step 1 — Pick a starting department", "Step 2 — Send your team the install link" — an onboarding template's checklist is not five commitments.
- A STANDING STATE. "Continue routing leads to the old inbox", "Keep the pricing change internal until the board meets", "Continue the current discount until the renewal" — asking someone to CARRY ON doing what already happens is a fact about the account, not a task; there is no moment at which it is done. A promise to keep a PERSON posted ("I will keep you updated on the Lumen Verify setup") IS a commitment.
- anything a machine wrote — "X has accepted this invitation", an automated notification, an unsubscribe footer

The SAME promise restated in several messages is ONE commitment. Use its clearest wording.

For each one:
- "title": imperative, names the deliverable. Self-contained — it will be read on its own with no thread around it.
- "owner_kind": "user" if ${ourName} owes it, "prospect" if ${theirName} owes it. An ASK counts: if ${ourName} asked ${theirName} to do something, ${theirName} owes it.
- "title" IS ALWAYS SOMETHING ${ourName} CAN DO. When ${ourName} owes it, that is the deliverable itself: "Send Marisol the Lumen Verify setup guide". When ${theirName} owes it, write ${ourName}'s side of it — the chase: "Follow up with ${theirName} on the signed Tidewell Starter Agreement", "Chase ${theirName} for the Lumen Verify account ID". Never write a title only ${theirName} could carry out; nobody here can tick that off.
- "stated_by": "us" if the sentence it appears in was written by ${ourName}, "them" if written by ${theirName}. An ask ${ourName} made is stated_by "us" even though ${theirName} owes it.
- "due_phrase": the timing AS WRITTEN, and self-contained. "by Friday the 5th of October", never "the 5th". "Right after this email" or "today" is timing too. Write it in English even when the conversation is not ("juste après notre appel" is "right after the call", "le 30 septembre" is "September 30"). null if no timing is stated.
- "quote": the exact sentence the promise was made in, copied verbatim from the thread.
- "context": ONE sentence a reader without the thread needs in order to act — what exactly is being sent or done, and why it came up. Never restate the title. "" when the title already says it all.

Be strict about the shapes above. If nothing is clearly actionable, return [].

Thread:
"""${text}"""

Output ONLY a JSON array, max 6 items:
[{"title":"…","owner_kind":"user|prospect","stated_by":"us|them","due_phrase":"…|null","quote":"…","context":""}]`;
}

/**
 * The checked sentence a commitment rests on — the section-4 guard, applied to promises.
 *
 * WHO OWES IT AND WHO SAID IT ARE DIFFERENT QUESTIONS, and conflating them cost about a quarter
 * of the commitments their quote in an early sample — every single ungrounded one. Brief §11 says a
 * prospect-owned item is "they promised, OR the user asked them to do it", and an ASK is written in
 * OUR message: "Please provide the five-digit Ledgerway branch code", "Send the Articles of
 * Incorporation". Grounding those against the customer's side refuses them, correctly by the old
 * rule and wrongly in fact — the sentence exists, we wrote it, and it is the right evidence for it.
 *
 * So the model says which side STATED it, and that is the side the quote must come from. What the
 * guard still refuses is the thing it was built for: a promise attributed to THEM that rests on our
 * restatement of them — "as you mentioned, you'll send us the vendor list" — because there the
 * claim is about what they undertook and our sentence is not evidence of it.
 */
export function groundCommitmentQuote(quote, statedBy, text, theirText = null) {
  const corpus = statedBy === 'them' ? (theirText ?? theirSideOf(text)) : text;
  return groundQuote(quote, corpus);
}

/**
 * Which side wrote the sentence a commitment appears in.
 *
 * The model is asked directly. When it does not say, fall back to the owner — a promise someone
 * made is usually stated by them — which is the old behaviour and still right for the common case.
 */
export function statedSideOf(item, owner) {
  const said = String(item?.stated_by ?? '').toLowerCase();
  if (said === 'us' || said === 'them') return said;
  return owner === 'prospect' ? 'them' : 'us';
}

/**
 * Commitments from one thread, filed on the counterpart.
 *
 * The section-4 guard applies here exactly as it does to claims: a commitment attributed to THEM
 * may only quote THEIR messages. A promise we made, quoted from our own message, is correct — so
 * the corpus a quote is checked against depends on who is said to have made it.
 */

/**
 * The live tasks the last read of this thread produced (GET-426). Ranged, never a prefix LIKE —
 * that scan is what GET-396/414 cost us twice.
 */
async function threadTaskIds(supabase, workspaceId, id) {
  const lo = `action_item.${SOURCE}_${id}_`;
  const { data, error } = await supabase.from('claims').select('id, property')
    .eq('workspace_id', workspaceId).gte('property', lo).lt('property', `${lo}a`)
    .is('invalid_at', null).limit(100);
  if (error) { console.warn(`[GMAIL] could not read the previous tasks for ${id}: ${error.message}`); return []; }
  return data ?? [];
}

export async function extractThreadCommitments({
  supabase, workspaceId, thread, text, theirName, ourName, ourSide = null, contactId, dryRun = false, now = Date.now(),
}) {
  const result = await read({
    supabase, workspaceId,
    feature: 'gmail-thread-commitments',
    meterAs: 'signal-extraction',
    accept: acceptsArray,
    parse: parseArray,
    maxTokens: 700,
    prompt: buildCommitmentPrompt({ text, theirName, ourName }),
  });
  if (!result.ok) return { filed: [], ok: false, reason: result.reason };

  let flipped = 0;
  const theirText = theirSideOf(text);
  const timeZone = await getWorkspaceTimezone(supabase, workspaceId).catch(() => undefined);
  const anchor = new Date(lastAt(thread) ?? now);
  const id = threadId(thread);
  const filed = [];
  // A RE-READ REPLACES THE LAST READ (GET-426), the same rule meetings have had since GET-410.
  // The property is deterministic per (thread, index), so a re-run overwrites index for index —
  // but the model does not number commitments the same way twice, and a read that now yields
  // three where it once yielded five leaves two stale rows live forever. So the previous read's
  // tasks for this thread are retired, and only the ones this read rewrote survive.
  const previousIds = dryRun ? [] : await threadTaskIds(supabase, workspaceId, id);
  const written = new Set();
  // Provenance, stamped once here where the thread is in hand (GET-400): the subject as its title,
  // the last message's time as when it was said, and the account's one open deal, if it has one.
  const subject = String(thread.messages?.find(m => m.subject)?.subject ?? '').trim() || null;
  const deal = result.value.length && !dryRun
    ? await dealForTask(supabase, workspaceId, { companyEntityId: await companyOfContact(supabase, workspaceId, contactId).catch(() => null) })
    : { deal_id: null, deal_link: null };

  for (let i = 0; i < Math.min(result.value.length, 6); i++) {
    const it = result.value[i];
    if (!it?.title || typeof it.title !== 'string') continue;
    const owner = it.owner_kind === 'prospect' ? 'prospect' : 'user';
    // A TASK IS FOR OUR PEOPLE — SO A THING THEY OWE US BECOMES OUR CHASE (GET-425).
    //
    // Close to half of one corpus's email tasks were the customer's homework: "Sign and return the
    // Tidewell Starter Agreement", "Provide the Lumen Verify account ID". Nobody here can tick those off, and
    // dropping them loses the part a CS rep is actually paid for. So they are not dropped and not
    // filed as theirs — they are turned round: the row becomes ours ("Follow up with Larkfield Systems on
    // the signed agreement"), flagged `awaiting_them` with their name, so the account page can say
    // who we are waiting on without putting a row in their name in our list.
    const theirs = owner === 'prospect';
    if (theirs) flipped++;

    const statedBy = statedSideOf(it, owner);
    const quote = groundCommitmentQuote(it.quote, statedBy, text, theirText);
    // A machine's notification cannot support a commitment (GET-423). A few percent of one workspace's
    // gmail tasks were "Attend the <meeting>" resting on "X has accepted this invitation" — a row
    // no action completes and no evidence closes.
    if (isAutoNotification(quote) || isAutoNotification(it.quote)) {
      console.log(`[GMAIL] dropped a commitment — ${AUTO_NOTIFICATION_REASON}: "${String(it.quote ?? '').slice(0, 70)}"`);
      continue;
    }
    // …and the two other shapes that are decidable from the quote alone (GET-423).
    const refuse = notACommitment(quote ?? it.quote, it.title);
    if (refuse) {
      console.log(`[GMAIL] dropped a commitment — ${refuse}: "${String(it.quote ?? '').slice(0, 70)}"`);
      continue;
    }

    const value = {
      ...emptyTaskProvenance(),
      ...provenanceFromModel(it, it.title),
      // An email has two people on it. What we owe is for them; what they owe is for us.
      // Only OUR commitments reach here (GET-424), so the person waiting is always the counterpart.
      for_name:      theirName,
      for_entity_id: contactId ?? null,
      // Who raised it: the side that wrote the sentence, when that is not the side that owes it.
      // Who raised it: them, when we are doing it because they asked rather than because we offered.
      asked_by:      statedBy === 'them' ? theirName : null,
      source_title:  subject,
      source_url:    gmailThreadUrl(thread),
      occurred_at:   anchor.toISOString(),
      deal_id:       deal.deal_id,
      deal_link:     deal.deal_link,
      title:       tidyFactContent(it.title, null).slice(0, 300),
      // OURS, always (GET-425). `awaiting_them` is what makes a chase readable as a chase.
      owner_kind:  'user',
      awaiting_them: theirs || null,
      owed_by:     theirs ? theirName : null,
      stated_by:   statedBy,
      // Only ever OUR people. A customer's promise must never name one of our reps as its owner —
      // that is how a rep's queue fills with other people's homework.
      owner_email: ourSide?.ownerEmail ?? null,
      owner_name:  ourSide?.ownerName ?? null,
      status:      'open',
      due_phrase:  it.due_phrase || null,
      // The model says the phrase; code computes the date, against the THREAD's last message
      // rather than the run — "by Friday" in a March thread is a March date. dueDateAgreeingWith
      // then drops a date the title contradicts (GET-348).
      due_at:      dueDateAgreeingWith(resolveDuePhrase(it.due_phrase, anchor, timeZone), it.title),
      source_type: 'email',
      source_id:   String(id),
      source_ref:  threadSourceRef(thread),
      quote,
      recorded_at: new Date(now).toISOString(),
    };

    if (dryRun) { filed.push(value); continue; }
    await recordObservation(supabase, {
      workspaceId,
      entityId: contactId,          // the counterpart — where the email_sent evidence also lands
      kind: 'state',
      // Deterministic per (source, thread, index): a re-run overwrites instead of duplicating.
      property: `action_item.${SOURCE}_${id}_${i}`,
      value,
      source: SOURCE,
      // REQUIRED, and only --apply could find that out: `method` is NOT NULL, the dry run never
      // reaches the write, and every commitment insert failed on it. The message action-item path
      // has always passed 'extraction'; this is the same kind of write and uses the same value.
      method: 'extraction',
      observedAt: value.recorded_at,
    });
    filed.push(value);
    written.add(`action_item.${SOURCE}_${id}_${i}`);
  }
  if (!dryRun && previousIds.length) {
    const stale = previousIds.filter(r => !written.has(r.property)).map(r => r.id);
    if (stale.length) {
      const { error } = await supabase.from('claims').update({ invalid_at: new Date().toISOString() }).in('id', stale);
      if (error) console.warn(`[GMAIL] could not retire ${stale.length} task(s) from the previous read: ${error.message}`);
      else console.log(`[GMAIL] retired ${stale.length} task(s) the previous read of this thread left behind`);
    }
  }
  if (flipped) console.log(`[GMAIL] ${flipped} commitment(s) the customer owes — filed as our follow-ups (GET-425)`);
  return { filed, ok: true };
}

// ── the Read ──────────────────────────────────────────────────────────────────

/**
 * Read one thread: claims always, commitments only while it is live.
 *
 * @returns {{ sourceRef, facts, commitments, treatment, skipped?: string }}
 */
export async function readGmailThread({ supabase, workspaceId, thread, dryRun = false, now = Date.now(),
  // COMMITMENTS ONLY (GET-422): skip the claim and insight passes and run only the commitments
  // read. For threads already read before tasks carried provenance (GET-400) — one read each
  // instead of re-buying the claims and insights that are already on the graph and fine.
  commitmentsOnly = false,
}) {
  const sourceRef = threadSourceRef(thread);
  const text = renderThread(thread);
  const treatment = threadTreatment(thread, now);

  // The counterpart this thread is filed against. `externalIds` is set by selectEmailThreads and
  // is already filtered to active external people.
  //
  // The first one is not good enough. A claim needs a subject with a NAME, and taking
  // externalIds[0] threw away whole threads when position zero happened to be a nameless record:
  // two threads in an early sample went that way, each a dozen-odd messages long, with several
  // people on them — most of whom had perfectly good names (Orrin Vakeel, Sunniva Marsh,
  // Teodor Quayle…). The thread was dropped on the alphabetical accident of who sorted first.
  //
  // So: the first counterpart that CAN be a subject. Nameless records are not skipped because
  // they are worthless — they are skipped because a claim filed against "" is unreadable.
  if (!thread.externalIds?.length) return { sourceRef, facts: [], commitments: [], treatment, skipped: 'no external counterpart' };

  let contactId = null, contact = null;
  for (const id of thread.externalIds) {
    const candidate = await loadSubject(supabase, id);
    if (candidate?.name) { contactId = id; contact = candidate; break; }
  }
  if (!contact) return { sourceRef, facts: [], commitments: [], treatment, skipped: 'no named counterpart' };

  // WHICH OF US WROTE THIS THREAD. loadOurSide resolves our person from an observation's
  // owner_user_id — but only when given an activityId. Without one it falls back to
  // soleTeamSpeaker, which looks for transcript-style "Name:" lines; a rendered thread has
  // "--- us · addr · day ---" headers and never those, so ownerName was ALWAYS null here.
  // Every prompt on this path said "our team" where it could have said the rep's name, and every
  // commitment it filed was owner-less — hundreds of tasks with nobody to do them.
  //
  // The id of OUR first message, not the thread's first: an inbound opener is filed under whoever
  // received it, which is a weaker signal for "who is running this conversation" than the person
  // who actually replied.
  const ourFirst = thread.messages.find(m => m.side === 'us') ?? thread.messages[0];
  const ourSide = await loadOurSide(supabase, workspaceId, { activityId: ourFirst?.id ?? null, text });
  const ourName = ourSide?.ownerName || ourSide?.companyName || 'our team';

  // Claims. The model reads the whole thread; a claim may only rest on their side of it.
  const out = commitmentsOnly ? { facts: [], offered: 0, grounded: 0 } : await extractFactsFromText({
    contactName: contact.name,
    company: contact.company,
    type: 'email_thread',
    text,
    ourSide,
    groundAgainst: (partText) => theirSideOf(partText),
    // Relative dates resolve against the thread's newest message, the date its claims are filed
    // under (GET-1051); the prompt asks for each message's own date where the thread shows it.
    anchor: lastAt(thread), timeZone: await getWorkspaceTimezone(supabase, workspaceId).catch(() => undefined),
    // What is on file that this thread may move (GET-770).
    positionsOnFile: await loadPositionsOnFile(supabase, workspaceId, [contactId, contact.company_id], { excludeSourceRef: sourceRef }),
    // What is known about the account, so each line is read in context (GET-1033).
    accountBrief: await loadAccountBrief(supabase, workspaceId, { contactId, companyId: contact.company_id }),
    // METER THEM. Without this the claim calls are invisible: commitments go through read(),
    // which meters, and claims did not — so llm_usage showed roughly half of what a run cost and
    // every per-thread figure quoted from it was half the truth. A cost you cannot see is one you
    // cannot approve, and the whole staged-batch approach rests on approving it.
    onCall: (msg) => meterLLM(supabase, workspaceId, 'signal-extraction', msg),
  });

  const kept = out.facts.map(f => ({
    ...f,
    contactId,
    activityId: thread.messages[0]?.id ?? null,
    sourceActivityIds: thread.messages.map(m => m.id),
    companyId: contact.company_id ?? null,
  }));

  const facts = await persistFacts(supabase, workspaceId, kept, {
    // Filed under the thread's newest message, not under the day we read it (GET-770).
    type: 'email_thread', source: SOURCE, dryRun, sourceRef, occurredAt: lastAt(thread),
  });
  // What they said about us (GET-969): the same read, their side of the thread only.
  if (!dryRun && out.aboutUs?.length) {
    await saveAboutUsClaims(supabase, workspaceId, (await screenFeatureRequests(supabase, workspaceId, out.aboutUs)).map(f => ({ ...f, contactId, companyId: contact.company_id ?? null })),
      { sourceRef, sourceSystem: SOURCE, occurredAt: lastAt(thread), quotePrivate: true });
  }

  // INSIGHTS — the half that was never wired. Claims are about THEM; insights are about US, and
  // the Gmail Read filed only the first. Every market signal, product ask and positioning
  // correction in hundreds of threads went nowhere, because this call did not exist. The meeting path has
  // always made it.
  //
  // The whole thread, not theirSideOf: an insight about us is legitimately drawn from what we
  // wrote as well as what they answered — that is the section-4 guard's other half, and the reason
  // it narrows claims and not this.
  //
  // AWAITED, unlike the meeting path, which fires it into setImmediate. A backfill has to be able
  // to say what it wrote — the read marker records the count, and a marker that says "read" while
  // the insight pass was still running is the same unverifiable claim the marker exists to end.
  // Failure is caught and counted as zero, so a thread never loses its claims to a slow insight.
  let insights = 0;
  let insightStatus = null;
  if (!dryRun && !commitmentsOnly) {
    insights = await extractCallInsights({
      onResult: (r) => { insightStatus = r; },
      supabase, workspaceId,
      transcript: text.slice(0, 60_000),
      sourceLabel: [contact.name, contact.company].filter(Boolean).join(', ') || null,
      attendees: [contact.name].filter(Boolean),
      occurredAt: lastAt(thread),
      sourceRef, sourceSystem: SOURCE,
      // A quote must be in what THEY wrote (GET-974): our own lines are not their evidence.
      groundAgainst: theirSideOf(text),
    }).catch(err => { console.warn('[GMAIL] insight pass failed:', err.message); insightStatus = { ok: false, reason: 'error' }; return 0; });
  }

  let commitments = [];
  let commitmentStatus = null;
  // Tasks only from a thread active in the last 30 days (GET-514): a backfill reads three months
  // for facts and insights, but a July promise filed today is a stale row, not a task.
  if ((treatment === 'live' && writesTasks(lastAt(thread), now)) || commitmentsOnly) {
    const c = await extractThreadCommitments({
      supabase, workspaceId, thread, text, theirName: contact.name, ourName, ourSide, contactId, dryRun, now,
    });
    commitments = c.filed;
    commitmentStatus = c.ok === false ? { ok: false, reason: c.reason } : { ok: true };
  }

  // WHO this was filed against, echoed so a run can be checked rather than trusted. "Filed on the
  // right accounts" is part of the definition of done and was the one criterion the dry runs could
  // not actually test — the output named a count of contacts and never which ones.
  // Written LAST and unconditionally — a thread that yielded nothing was still read and still
  // cost money, and that is the case the old claims-based marker could not represent.
  // A commitments-only pass does not re-mark the thread: the marker records what the full read
  // produced, and overwriting it with "0 claims, 0 insights" would make a fully-read thread look
  // unread to the next resume (GET-356's shape).
  const markable = shouldMarkThreadRead({ insights: insightStatus, commitments: commitmentStatus });
  if (!dryRun && !commitmentsOnly && !markable) {
    console.warn(`[GMAIL] thread ${threadId(thread)}: a model step was unavailable — not marked read, the next run reads it again`);
  }
  if (!dryRun && !commitmentsOnly && markable) {
    await markThreadRead(supabase, workspaceId, thread, contactId, { facts, commitments, insights, treatment, now })
      .catch(e => { markerFailures++; console.warn('[GMAIL] read marker failed:', e.message); });
  }

  return {
    sourceRef, facts, commitments, insights, treatment, offered: out.offered, grounded: out.grounded,
    filedOn: { contactId, contact: contact.name, company: contact.company ?? null },
  };
}
