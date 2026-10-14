// The call scorer — Coaching v2 (GET-83). One LLM pass over a call transcript that grades it
// against the workspace rubric and stores a scorecard. Mirrors the insights extractor: reads the
// same transcript, but instead of mining facts it judges HOW the rep did. Runs once per external
// (customer-present) call, after extraction, attributed to the hosting rep.
//
// The model is the extraction pipeline's (GET-236): EXTRACTION_MODEL answers (DeepSeek V4.1 Flash
// in prod) and EXTRACTION_FALLBACK_MODEL (GLM 5.2) answers when it can't, both through
// lib/llm.mjs. Scoring used to read the INSIGHTS_* settings and ran on an older GLM with no
// fallback at all; one door means a model change for extraction is a model change here too.
//
// A call is run by a TEAM (GET-246, ruled 2026-09-14). The host — the calendar organizer, else
// whoever recorded — owns it; every teammate on it gets Coaching credit; the review is told who is
// on our side and grades the team. When two teammates both record the call, the second recording
// joins the first call instead of vanishing, and it re-runs the review only when its transcript
// names its speakers and the first one's did not.

import {
  writesTasks,
  getCoachingRubric,
  buildCallScorePrompt,
  buildCallTypePrompt,
  parseCallType,
  callTypeAgainstRoom,
  parseCallScoreJson,
  isGradedCallType,
  buildHealthReadPrompt,
  parseHealthReadJson,
  buildCommitmentsPrompt, parseCommitmentsJson,
  writeHealthPage,
  healthSignalsToSave,
  HEALTH_SIGNAL,
  saveNote,
  recordObservation,
  resolveDuePhrase, dueDateAgreeingWith,
  getWorkspaceTimezone,
  enqueueGithubDispatches,
  callScoreFromStored,
  saveDocument,
  talkShareFromTranscript,
  sidesOfCall,
  resolveCallTarget,
  storeCallReview,
  emptyTaskProvenance, provenanceFromModel, matchPersonByName, dealForTask, companyOfContact,
  isAutoNotification, AUTO_NOTIFICATION_REASON, notACommitment,
  previousMeetingTasks, carriedOver, retirePreviousMeetingTasks, retireMeetingNotes, repeatsFiledTask,
  emitEvent, runCallEndedAutomations,
} from '@nous/core';
import { createMessage, pipelineModel } from '../lib/llm.mjs';
import { spokenByOurSide } from '../noema/grounding.mjs';
import { meterLLM } from '../utils/meterLLM.mjs';
import { logSysEvent } from '../utils/systemLog.mjs';

/** `a@b.co` → `b.co`. Empty for anything that is not an address. */
const emailDomain = (email) => String(email ?? '').toLowerCase().split('@')[1]?.trim() || '';

// WHAT COUNTS AS A USABLE ANSWER DEPENDS ON THE QUESTION. Anything else (empty, cut off, prose)
// hands the call to the fallback model.
//
// One gate for three different prompts was a silent 2x bill. `usableReview` demands a `call_type`
// field — right for the classifier and the scorecard, and impossible for a health read, which
// returns standing, risks and expansion signals and never mentions a call type. So every business
// review and training call was answered correctly by DeepSeek, REJECTED, re-asked of GLM 5.2 with
// the same 60,000-character transcript, rejected again, logged as LLM_FALLBACK_EXHAUSTED, and then
// used anyway. The page was always right; we just paid twice for it, on the dearer model, and the
// logs cried wolf on every CS call.
const usableReview = (text) => /\{[\s\S]*"call_type"[\s\S]*\}/.test(String(text ?? ''));
export const usableHealthRead = (text) => /\{[\s\S]*"standing"[\s\S]*\}/.test(String(text ?? ''));
const usableCommitments = (text) => /\{[\s\S]*"commitments"[\s\S]*\}/.test(String(text ?? ''));

const fullName = (c) => [c?.first_name, c?.last_name].filter(Boolean).join(' ') || null;

/** The people on a call as the review should name them, from the contacts the meeting resolved to. */
export function peopleFromContacts(contacts) {
  return (contacts || []).map(c => ({
    name:    fullName(c),
    email:   c.email || null,
    company: c.company || null,
  })).filter(p => p.name || p.email);
}

async function runScoreModel(prompt, supabase, workspaceId, accept = usableReview) {
  const msg = await createMessage({
    feature: 'call-scoring',
    model: pipelineModel(),
    // The review writes the call page too (two-paragraph summary, verdict, a 4–7 sentence quoted
    // note per dimension, went well / improve), so the answer is long. lib/llm.mjs adds reasoning
    // headroom on top for models that think first.
    max_tokens: 9000,
    messages: [{ role: 'user', content: prompt }],
    accept,
  });
  await meterLLM(supabase, workspaceId, 'call-scoring', msg);
  const block = (msg.content || []).find(b => b.type === 'text');
  return block?.text ?? '{}';
}

// Who is on the call, the second-recording merge, the scorecard write and the Call page live in
// @nous/core (callReviewStore.ts): the revenue plugin's reviews land through the same path (GET-260).

/**
 * Review one call: score it, store the scorecard, and file the call page in Pages (GET-236).
 * Best-effort: never throws into the ingest pipeline. Returns the CallScore (or null on
 * skip/failure) so a test harness can inspect it.
 *
 *   supabase, workspaceId — context
 *   transcript            — the call text (the same extractionText the extractors read)
 *   role                  — the rep's GTM role for the rubric (falls back to the AE default)
 *   repUserId             — the HOST: the calendar organizer when they are on the team, else the
 *                           recorder (resolveCallHost). Owns the call.
 *   entityId              — the primary buyer contact (derived from `contacts` when omitted)
 *   meetingId, source, occurredAt — this recording's identity + the call's time
 *   title, sourceUrl      — the call's name and this recording's link back to the note-taker
 *   contacts              — every contact the meeting resolved to; split into team and buyers here
 *   recorder              — {name, email, userId} of the teammate whose note-taker recorded it
 *   namedSpeakers         — true when this transcript names who said each line
 *   repTalkShare          — the recorder's measured share of speaking time (0–1), when known
 *   accountEntityId, mentionEntityIds, rep, people — older callers; derived from `contacts` now
 */
// The customer calls we READ rather than grade. Everything else that is graded keeps its rubric.
const HEALTH_READ_TYPES = new Set(['business_review', 'training']);

/**
 * What a call of this type earns: a health read, a coaching review, or neither.
 *
 * Pulled out as a rule of its own so the one invariant that matters here cannot be lost in a later
 * edit: `skipCoaching` withholds the REP GRADE and nothing else. A business review still produces
 * its page, its standing and its risk and expansion claims, because those are the account record,
 * not a critique of a seller. Put the skip one branch earlier and a history import would quietly
 * stop building account health — the exact thing a history import is run for.
 */
/**
 * An entity a call page may be filed on, or null.
 *
 * The only rule: never one of our own people. A call page answers "what happened with this
 * account", so filing it on the seller's own employee is not a lesser answer, it is a wrong one —
 * it puts a customer's risks and commitments on a colleague's record.
 */
export function pageSubject(entityId, ourEntityIds) {
  if (!entityId) return null;
  return (ourEntityIds instanceof Set && ourEntityIds.has(entityId)) ? null : entityId;
}

export function callPlan(callType, { skipCoaching = false } = {}) {
  if (HEALTH_READ_TYPES.has(callType)) return 'health_read';
  if (!isGradedCallType(callType)) return 'skip';
  return skipCoaching ? 'skip' : 'coach';
}

/**
 * File a meeting's commitments as tasks — with provenance, carried-over closure state, and the
 * previous read retired (GET-400, 410). One function for the health read, the commitments-only
 * read on every other call type (GET-418), and the backfill's --commitments-only mode (GET-420).
 */
export async function fileMeetingCommitments(ctx, commitmentsToFile) {
  const { supabase, workspaceId, meetingId, source, title, sourceUrl, at, contacts, recorder, account, primary } = ctx;
  // Tasks only from a call in the last 30 days (GET-514); an older call still gives its claims.
  if (!writesTasks(at)) return 0;
  const subjectEntityId = account || primary;
  // A COMMITMENT IS A TASK THAT WAS NEVER FILED.
  //
  // The health read has always found these — "I'll send the export fix by Friday" — and shown them
  // on the call page, and then dropped them. Meanwhile action_item.* exists, with a two-tier
  // engine that closes a commitment when the record shows it was kept: deterministic rules for
  // the common verbs (promised to email, an email followed), and for everything else the next
  // conversation, where the model must quote the evidence before it may call anything done.
  //
  // Nothing connected the two. Meetings were meant to be covered by Fireflies, which supplies
  // action items in its own payload; Fellow does not, and ACTION_ITEM_CHANNELS holds only email
  // and LinkedIn. So dozens of meetings produced hundreds of open risks and zero tasks.
  //
  // Written in the same shape and with the same deterministic property, so a re-run overwrites
  // rather than duplicating, and so the completion engine picks them up without knowing where
  // they came from.
  const timeZone = await getWorkspaceTimezone(supabase, workspaceId).catch(() => undefined);
  let filed = 0, flipped = 0;
  // PROVENANCE IS STAMPED HERE, ONCE, because here is the only place it is free (GET-400).
  // The title, the date, the link and the roster are all in scope right now; on read, each of
  // them is a lookup per task against a table that times out on the obvious query. So the
  // task carries them. The deal is decided the same way: the account's one open deal at the
  // time of the call, or nothing — never a guess between two.
  const roster = Array.isArray(contacts) ? contacts : [];
  const companyForDeal = account || (await companyOfContact(supabase, workspaceId, primary).catch(() => null));
  const deal = (commitmentsToFile ?? []).length
  ? await dealForTask(supabase, workspaceId, { companyEntityId: companyForDeal })
  : { deal_id: null, deal_link: null };
  // The recorder's NAME, when the note-taker sent only an address: the roster usually holds
  // them as a contact ("Juno Pellard", juno@harborline.example), and a task should say so.
  const recorderName = recorder?.name
  ?? (recorder?.email ? roster.find(c => String(c?.email ?? '').toLowerCase() === String(recorder.email).toLowerCase()) : null)
  ?? null;
  const ownerName = recorderName && typeof recorderName === 'object'
  ? ([recorderName.first_name, recorderName.last_name].filter(Boolean).join(' ') || null)
  : recorderName;
  // A RE-READ REPLACES THE LAST READ (GET-409). What the last read filed for this meeting is
  // loaded first — so a task someone closed stays closed — and retired afterwards where this
  // read did not rewrite it. The observation is stamped with the time of the READ, not the
  // call: deriveClaim lets the newest observed_at win, and two reads stamped with the call's
  // date tie, leaving the first value in place. The call's date is `occurred_at` on the value.
  // If the previous read cannot be loaded, say so where it will be seen. Filing still goes
  // ahead — a task on the row beats none — but the log line is the difference between "this
  // meeting had no tasks before" and "we could not look", which the data cannot tell apart.
  const previous = await previousMeetingTasks(supabase, workspaceId, String(meetingId)).catch(err => {
  console.error(`[call-tasks] ${source} ${meetingId}: could not load the previous read's tasks — supersession skipped: ${err.message}`);
  return [];
  });
  const readAt = new Date().toISOString();
  const written = [];
  // THE SAME CALL RECORDED TWICE FILES ITS TASKS ONCE (GET-786). Two recordings of one call are two
  // meeting ids, so supersession (keyed per meeting) never saw them as one. On a meeting's FIRST
  // read, a commitment that repeats a task another recording of the call already filed is skipped.
  // A re-read never skips: its rows replace its own last read, and skipping one would retire a
  // task someone may have closed by hand in favour of the other recording's open copy.
  const onRecord = subjectEntityId && !previous.length
    ? await supabase.from('claims').select('value').eq('workspace_id', workspaceId).eq('entity_id', subjectEntityId)
        .like('property', 'action_item.meeting_%').is('invalid_at', null).limit(2000)
        .then(({ data, error }) => { if (error) throw error; return data ?? []; })
        .catch(err => { console.error(`[call-tasks] ${source} ${meetingId}: could not load the record's tasks — duplicate check skipped: ${err.message}`); return []; })
    : [];
  for (let i = 0; i < (commitmentsToFile ?? []).length; i++) {
  const c = commitmentsToFile[i];
  // A TASK IS FOR OUR PEOPLE — SO A THING THEY OWE US BECOMES OUR CHASE (GET-425). A commitment
  // the customer made is not dropped and not filed in their name: the row becomes ours ("Follow
  // up with Tamsin on the emails"), flagged `awaiting_them`, so nobody here holds a row they
  // cannot tick off and the chase is not lost either.
  const theirs = c.owner === 'them';
  if (theirs) flipped++;
  const entityId = subjectEntityId || primary;
  if (!entityId) continue;
  // Who it is FOR. The model names them as the call did ("Tamsin"); the roster turns that into
  // an entity when exactly one person on the call answers to it. A commitment the customer
  // made with nobody named is for us — the rep who ran the call.
  // A machine's notification is not a commitment (GET-423). Rare on a transcript, but the health
  // read also reads pasted notes, and one rule in both paths beats two that drift.
  if (isAutoNotification(c.quote)) { console.log(`[call-tasks] ${source} ${meetingId}: dropped a commitment — ${AUTO_NOTIFICATION_REASON}`); continue; }
  const refuse = notACommitment(c.quote, c.text);
  if (refuse) { console.log(`[call-tasks] ${source} ${meetingId}: dropped a commitment — ${refuse}`); continue; }
  if (repeatsFiledTask(onRecord, { title: c.text, sourceId: String(meetingId), at })) {
    console.log(`[call-tasks] ${source} ${meetingId}: dropped a commitment — another recording of this call already filed it`);
    continue;
  }
  const forName = c.for || (c.owner === 'them' ? (recorder?.name ?? null) : null);
  const forPerson = matchPersonByName(forName, roster);
  await recordObservation(supabase, {
    workspaceId, entityId, kind: 'state',
    property: `action_item.meeting_${meetingId}_${i}`,
    value: {
      ...emptyTaskProvenance(),
      ...provenanceFromModel(c, c.text),
      for_name:      forPerson ? ([forPerson.first_name, forPerson.last_name].filter(Boolean).join(' ') || forName) : forName,
      for_entity_id: forPerson?.id ?? null,
      source_title:  title || null,
      source_url:    sourceUrl || null,
      occurred_at:   at,
      deal_id:       deal.deal_id,
      deal_link:     deal.deal_link,
      title:       c.text.slice(0, 300),
      // OURS, always (GET-425); `awaiting_them` is what makes a chase readable as a chase.
      owner_kind:  'user',
      awaiting_them: theirs || null,
      owed_by:     theirs ? (c.for || null) : null,
      // WHO OWES IT, as an address rather than a seat (GET-383).
      //
      // The person who made the commitment usually has no account yet: one customer runs its
      // calls through many distinct host addresses and holds only a few seats. Stamping a
      // user_id here would mean stamping null forever, so the task carries the recorder's
      // email and the seat is resolved on read (core/services/taskAssignee.ts). Onboard that
      // address later and every task they ever promised becomes theirs, with no backfill.
      //
      // Only for OUR side — a commitment the customer made is never owed by one of our
      // people, and naming a rep on it would nag them for work that was never theirs.
      owner_email: recorder?.email ?? null,
      owner_name:  ownerName,
      status:      'open',
      due_phrase:  c.due || null,
      // The model says the phrase; code computes the date, against the CALL's date rather
      // than whenever this pass happened to run.
      // ...and dropped when the title contradicts it. "Schedule the October check-in for
      // Monday the 5th" handed over "the 5th", which resolved a month early against the
      // call's own date and then reported itself overdue (GET-348).
      due_at:      dueDateAgreeingWith(resolveDuePhrase(c.due, new Date(at), timeZone), c.text),
      source_type: 'meeting',
      source_id:   String(meetingId),
      quote:       c.quote || null,
      // Carried over from the last read: a closed task stays closed, a reopen keeps its line.
      ...carriedOver(previous, entityId, `action_item.meeting_${meetingId}_${i}`, c.text),
    },
    source: `${source}:health`,
    method: 'extraction',
    observedAt: readAt,
  }).then(() => { filed++; written.push({ entityId, property: `action_item.meeting_${meetingId}_${i}` }); })
    .catch(err => console.warn('[call-tasks] commitment failed', err.message));
}
const retired = await retirePreviousMeetingTasks(supabase, previous, written).catch(err => {
  console.error(`[call-tasks] ${source} ${meetingId}: could not retire the previous read's tasks: ${err.message}`);
  return 0;
});
console.log(`[call-tasks] ${source} ${meetingId}: previous read held ${previous.length} task(s), retired ${retired}`);
if (filed) console.log(`[call-tasks] ${source} ${meetingId}: ${filed} commitment(s) filed as tasks`);
if (flipped) console.log(`[call-tasks] ${source} ${meetingId}: ${flipped} commitment(s) the customer owes — filed as our follow-ups (GET-425)`);
}

/**
 * One commitments-only read of a transcript, then the filing (GET-418/420). What a call that is
 * not a health read does inside scoreCall, exposed so the backfill can do it on its own.
 */
export async function readAndFileMeetingCommitments({ supabase, workspaceId, transcript, meetingId, source, title = null, sourceUrl = null, occurredAt = null, contacts = [], recorder = null, accountEntityId = null, entityId = null, repUserId = null, callType = null }) {
  if (!transcript || transcript.length < 200) return { filed: 0 };
  const at = occurredAt || new Date().toISOString();
  const sides = Array.isArray(contacts) && contacts.length ? await sidesOfCall(supabase, workspaceId, { contacts, hostUserId: repUserId, recorder }).catch(() => null) : null;
  const text = await runScoreModel(buildCommitmentsPrompt(transcript.slice(0, 60000), { title, callType, people: sides?.people }), supabase, workspaceId, usableCommitments)
    .catch(err => { console.warn(`[call-tasks] ${source} ${meetingId}: commitments read failed: ${err.message}`); return null; });
  const found = text ? parseCommitmentsJson(text) : [];
  const primary = entityId ?? sides?.buyers?.[0]?.id ?? null;
  await fileMeetingCommitments({ supabase, workspaceId, meetingId, source, title, sourceUrl, at, contacts, recorder, account: accountEntityId, primary }, found);
  return { filed: found.length };
}

export async function scoreCall({
  supabase, workspaceId, transcript, role = 'default', repUserId = null, entityId = null, meetingId, source = null, occurredAt,
  title = null, sourceUrl = null, accountEntityId = null, mentionEntityIds = [], sourceRef = null,
  rep = null, people = [], repTalkShare = null,
  contacts = null, recorder = null, namedSpeakers = false,
  // A historical import scores the call but must NOT fan out the after-call dispatch: a year of
  // meetings would fire a year of follow-up runs, all of them about calls that ended months ago.
  dispatch = true,
  // Read the account, do not grade the rep. A history import wants what the customer said; the
  // coaching half of that answer is a review of how a seller handled a call that ended months ago,
  // which nobody will ever act on and which is the single most expensive model call per meeting
  // (a whole 60,000-character rubric pass). Health reads are NOT coaching and are always kept:
  // they are how a business review becomes account standing, risks and expansion signals.
  skipCoaching = false,
  // Write the call page, or only the account record underneath it. A summary is read by a person
  // and a person does not read last March, so a backfill older than thirty days keeps the health
  // read — risks, expansion, commitments, all still live by their own windows — and skips the page
  // (GET-351, GET-355). Live ingest always writes one.
  writePage = true,
}) {
  try {
    if (!transcript || transcript.length < 200) return null; // too thin to score honestly
    const at = occurredAt || new Date().toISOString();

    // Who is on the call, on which side (when the handler passed the resolved contacts).
    const sides = Array.isArray(contacts) ? await sidesOfCall(supabase, workspaceId, { contacts, hostUserId: repUserId, recorder }) : null;
    const primaryEntityId = entityId || sides?.buyers?.[0]?.id || null;

    // WHO IS FROM ANOTHER COMPANY. Taken from the HOST's own email domain rather than from
    // `sides.buyers`: buyers are whoever is not asserted internal, and that assertion comes from
    // workspace MEMBERS — a client whose reps hold no seats has none, so its own staff read as
    // buyers. The host ran the call on our address, so anyone on a different domain is outside.
    // Free mail counts as outside: a buyer writing from gmail is still the customer.
    const ourDomain = emailDomain(recorder?.email);
    const externalAttendees = (Array.isArray(contacts) ? contacts : [])
      .map(c => String(c?.email ?? '').toLowerCase())
      .filter(e => e && (!ourDomain || emailDomain(e) !== ourDomain));

    // A PAGE IS NEVER FILED ON ONE OF OUR OWN PEOPLE. The handler already withholds an account it
    // cannot trust (GET-313), but withholding it here only fell through to `primaryEntityId` — the
    // first "buyer" — and on a workspace whose reps hold no seats that is one of our own staff. So
    // a customer's onboarding call filed itself on the customer's own employee, twice, including once
    // on top of a page that had just been corrected. Deciding the account in one place and filing
    // the page in another is how a fix passes its tests and still lands wrong.
    const ourEntityIds = new Set((Array.isArray(contacts) ? contacts : [])
      .filter(c => c?.id && c?.email && ourDomain && emailDomain(c.email) === ourDomain)
      .map(c => c.id));
    const account = pageSubject(accountEntityId, ourEntityIds);
    const primary = pageSubject(primaryEntityId, ourEntityIds);
    if (account !== accountEntityId || primary !== primaryEntityId) {
      console.warn(`[call-score] ${source} ${meetingId}: refusing to file this call on one of our own people`);
    }

    // ONLY A CUSTOMER PROVES TWO RECORDINGS ARE ONE CALL. Our own people are on every call, so
    // matching on any shared contact merged two different customers' onboarding calls — one CS
    // manager ran both within three hours, and Ashgrove Mills' conversation and Tessaly Labs'
    // became a single record with a single page. A contact with no email is left out: we cannot
    // tell whose side they are on, and a wrong merge costs more than a missed one.
    const externalContactIds = (Array.isArray(contacts) ? contacts : [])
      .filter(c => c?.id && c?.email && !ourEntityIds.has(c.id))
      .map(c => c.id);

    // The call this recording belongs to: its own, or one another recording already opened.
    const target = await resolveCallTarget(supabase, workspaceId, {
      meetingId: String(meetingId), source, url: sourceUrl, namedSpeakers, occurredAt: at,
      contacts: Array.isArray(contacts) ? contacts : [], sides, hostUserId: repUserId,
      matchContactIds: externalContactIds,
    });
    const existing = target.existing;
    if (existing) {
      const hadNames = (existing.recordings ?? []).some(r => r.named_speakers);
      if (hadNames || !namedSpeakers) {
        // Nothing better to read: list this recording and credit the team, on the review we have.
        const kept = callScoreFromStored(existing);
        await storeCallReview(supabase, workspaceId, {
          score: kept, rubric: { role: existing.rubric_role, version: existing.rubric_version }, target, sides,
          title, occurredAt: existing.occurred_at, accountEntityId: account, mentionEntityIds,
        });
        console.log(`[call-score] ${source} ${meetingId} is another recording of ${target.source} ${target.meetingId} — listed on the call, review kept`);
        return kept;
      }
      console.log(`[call-score] ${source} ${meetingId} names its speakers; re-reviewing call ${target.source} ${target.meetingId} from it`);
    }


    // WHAT KIND OF CALL IS THIS (GET-287). Cheap first pass — the title and the opening, not the
    // whole transcript — because the rubric has to be chosen BEFORE the review is written. One
    // rubric for everything graded a customer check-in on whether it closed.
    //
    // The attendee list goes in with it, and the answer is checked against it afterwards: the model
    // called a customer review `internal` off the title alone, and an internal call is neither
    // graded nor read, so the meeting produced nothing at all.
    const declaredType = parseCallType(
      await runScoreModel(
        buildCallTypePrompt(title, transcript.slice(0, 1500), { externals: externalAttendees }),
        supabase, workspaceId,
      ).catch(() => 'sales'),
    );
    const callType = callTypeAgainstRoom(declaredType, { hasExternalAttendee: externalAttendees.length > 0 });
    if (callType !== declaredType) {
      console.log(`[call-score] ${source} ${meetingId}: called ${declaredType}, but ${externalAttendees.join(', ')} ${externalAttendees.length === 1 ? 'is' : 'are'} not ours — reading it as ${callType}`);
    }
    // EVERY CALL FILES ITS COMMITMENTS (GET-418) — see fileMeetingCommitments.
    const fileCommitments = (list) => fileMeetingCommitments({ supabase, workspaceId, meetingId, source, title, sourceUrl, at, contacts, recorder, account, primary }, list);

    // conversation.call_ended (GET-559): once per call, after it is read, with what the read found.
    // Same gate as the after-call dispatch — a re-review or a historical import stays quiet.
    const callEnded = (data) => (!existing && dispatch
      ? emitEvent(supabase, {
          workspaceId, type: 'conversation.call_ended',
          accountId: account || null, personId: primary || null, occurredAt: at,
          dedupeKey: target.meetingId,
          revboxData:{owner_user_id:recorder?.userId??repUserId??null,transcript:transcript.slice(0,60000),attendees:(Array.isArray(contacts)?contacts:[]).filter(c=>c?.email&&!ourEntityIds.has(c.id)).map(c=>({name:c.name??null,email:c.email}))},
          data: { meeting_id: target.meetingId, title: title ?? null, source: target.source ?? source ?? null, source_ref: sourceRef ?? null, url: sourceUrl ?? null, call_type: callType, ...data },
        }).catch(() => 0)
      : Promise.resolve(0));

    // "When a call ends" automations (GET-706): once per customer call, after it is read, never
    // for a history import or a second recording. The transcript rides along for the write-up.
    const callAutomations = (summary = null) => (!existing && dispatch && externalAttendees.length
      ? runCallEndedAutomations(supabase, workspaceId, {
          meetingId: target.meetingId, sourceMeetingId: String(meetingId), title: title ?? null, occurredAt: at, source: target.source ?? source ?? null,
          url: sourceUrl ?? null, accountId: account || null, personId: primary || null, callType, summary, transcript,
          attendees: (Array.isArray(contacts) ? contacts : []).filter(c => c?.email && !ourEntityIds.has(c.id))
            .map(c => ({ name: c.name ?? ([c.first_name, c.last_name].filter(Boolean).join(' ') || null), email: c.email })),
        }).catch(err => { console.warn(`[call-ended] ${source} ${meetingId}: automations failed: ${err.message}`); return null; })
      : Promise.resolve(null));

    const plan = callPlan(callType, { skipCoaching });
    if (plan === 'health_read') {
      const text = await runScoreModel(
        buildHealthReadPrompt(transcript.slice(0, 60000), { title, callType, people: sides?.people }),
        supabase, workspaceId, usableHealthRead,
      );
      const health = parseHealthReadJson(text);
      if (!health) {
        console.warn(`[call-health] ${source} ${meetingId}: model output not readable, nothing stored`);
        return null;
      }
      // OUR WORDS ARE NOT THEIR FACTS (GET-417). A signal whose quote was spoken by our side —
      // the rep's pitch, the rep's guess about their business — is dropped here, mechanically,
      // whatever the prompt said. The transcript's speaker labels decide.
      const ourNames = [
        ...(sides?.people ?? []).filter(p => p.side === 'team').map(p => p.name),
        recorder?.name,
      ].filter(Boolean);
      const said = health.risks.length + health.expansion.length;
      health.risks = health.risks.filter(r => !spokenByOurSide(r.quote, transcript, ourNames));
      health.expansion = health.expansion.filter(e => !spokenByOurSide(e.quote, transcript, ourNames));
      const droppedOurs = said - (health.risks.length + health.expansion.length);
      if (droppedOurs) console.log(`[call-health] ${source} ${meetingId}: dropped ${droppedOurs} signal(s) quoting our own side`);
      const subjectEntityId = account || primary;
      const page = writePage
        ? await writeHealthPage(supabase, workspaceId, health, {
            source, meetingId, title, url: sourceUrl, occurredAt: at, callType,
            subjectEntityId, mentionEntityIds, repUserId,
            sourceRef, host: recorder?.name ?? recorder?.email ?? null,
          }).catch(err => { console.warn('[call-health] page failed', err.message); return null; })
        : null;

      // The signals become ordinary claims on the account — the same path extraction writes facts
      // through — so they accumulate across calls, carry their own evidence, and decay. Standing is
      // DERIVED from them (getAccountHealth), never stamped: a risk resolves by not being said
      // again, instead of being overwritten by the next unrelated training call (GET-290).
      if (subjectEntityId) {
        // THIS READ REPLACES THE LAST ONE. A meeting read twice doubled its risks and expansion
        // signals on the account (seen on a test workspace); the previous read's signals for
        // this meeting are retired before the new ones land.
        await retireMeetingNotes(supabase, workspaceId, {
          entityIds: [subjectEntityId], meetingId: String(meetingId), sources: [`${source}:health`],
        }).catch(err => console.error(`[call-health] ${source} ${meetingId}: could not retire the previous read's signals — duplicates possible: ${err.message}`));
        for (const sig of healthSignalsToSave(health, { at, sourceRef })) {
          await saveNote(supabase, workspaceId, {
            entityId: subjectEntityId,
            category: sig.category,
            content:  sig.content,
            source:   `${source}:health`,
            metadata: {
              signal_type: HEALTH_SIGNAL[sig.kind],
              // The adoption line is the page's prose, not a fact: a paragraph restating what the
              // extractor filed atomically. It stays for the health panel; it is not intel (GET-417).
              ...(sig.kind === 'adoption' ? { summary: true } : {}),
              // The sub-tags the category carries (GET-401). A health read's expansion is an
              // opening the customer raised, so it is an ask; it does not name a product family
              // yet, and a CS reader that needs one treats null as "not matched to the catalogue".
              // A health read's risk is graded at_risk: it came from a business review, not from
              // the customer giving notice — a stated cancellation reaches the graph through
              // extraction, which does grade it.
              ...(sig.kind === 'expansion' ? { stance: 'asked', product: null } : {}),
              ...(sig.kind === 'risk' ? { severity: 'at_risk' } : {}),
              quote: sig.quote,
              occurred_at: at,
              source_ref: sourceRef ?? null,
              meeting_id: meetingId,
            },
          }).catch(err => console.warn('[call-health] signal failed', err.message));
        }
      }

      await fileCommitments(health.commitments);
      await callAutomations(health.summary || null);
      await callEnded({
        summary: health.summary || null,
        what_changed: health.what_changed || null,
        standing: health.standing ?? null,
        risks: health.risks.map(r => ({ risk: r.text, quote: r.quote || null })),
        expansion: health.expansion.map(e => ({ signal: e.text, quote: e.quote || null })),
        commitments: (health.commitments ?? []).length,
      });

      console.log(`[call-health] ${source} ${meetingId} is a ${callType} — ${health.standing}, ${health.risks.length} risk(s), ${health.expansion.length} expansion signal(s)${page ? '' : writePage ? ' (no account to file it on)' : ' (no page — older than the summary window)'}`);
      return { call_type: callType, health, scores: [], overall: 0 };
    }

    // A call that is not a health read still made promises. One cheap read for the commitments
    // alone — same schema, same filing, same provenance — so a discovery or support call's "I'll
    // send that over Friday" becomes a task the way a review's does (GET-418).
    if (externalAttendees.length) {
      const text = await runScoreModel(
        buildCommitmentsPrompt(transcript.slice(0, 60000), { title, callType, people: sides?.people }),
        supabase, workspaceId, usableCommitments,
      ).catch(err => { console.warn(`[call-tasks] ${source} ${meetingId}: commitments read failed: ${err.message}`); return null; });
      const found = text ? parseCommitmentsJson(text) : [];
      await fileCommitments(found);
    }

    // Everything a health read would write has already happened above. What is left is the rubric
    // pass, and it is skipped either because this kind of call is not a coaching moment or because
    // the caller asked for the account and not the grade.
    if (plan === 'skip') {
      await callAutomations(null);
      const why = isGradedCallType(callType) ? 'coaching skipped by request' : 'not a coaching moment';
      console.log(`[call-score] meeting ${meetingId} is ${callType} — ${why}, not scored`);
      return { call_type: callType, scores: [], overall: 0, ...(skipCoaching && isGradedCallType(callType) ? { coaching_skipped: true } : {}) };
    }

    const rubric = await getCoachingRubric(supabase, workspaceId, role, callType);
    console.log(`[call-score] ${source} ${meetingId} is a ${callType} call — grading on the ${rubric.dimensions.map(d => d.key).join('/')} rubric`);
    const prompt = buildCallScorePrompt(rubric, transcript.slice(0, 60000), sides
      ? {
          people: sides.people,
          // A transcript that names its speakers is measured per person, team vs buyer; one that
          // only knows "me / them" (Granola) falls back to the recorder's microphone share.
          talk: namedSpeakers ? talkShareFromTranscript(transcript, sides.teamNames) : null,
          repTalkShare: namedSpeakers ? null : repTalkShare,
          callType,
        }
      : { rep, people, repTalkShare, callType });
    const text = await runScoreModel(prompt, supabase, workspaceId);
    const scored = parseCallScoreJson(text, rubric, callType);

    // The reviewer read the whole transcript and says it was not with a customer after all
    // (internal, investor, recruiting …): no scorecard, no page, no after-call dispatch.
    if (!isGradedCallType(scored.call_type)) {
      console.log(`[call-score] meeting ${meetingId} is ${scored.call_type}, not a sales call — not scored`);
      return scored;
    }

    // Parse-failure guard: if EVERY dimension is 0 with an empty note, the model output didn't parse
    // (truncated JSON, wrong shape) — that's not a real 0. Don't store a misleading score or fire a
    // dispatch that would draft a garbage review; log the head of the output and bail so a re-run can retry.
    const parseFailed = scored.scores.length > 0 && scored.scores.every(s => s.score === 0 && !s.note);
    if (parseFailed) {
      console.warn(`[call-score] parse failed for meeting ${meetingId} — model output not readable, not storing. head: ${String(text).slice(0, 200)}`);
      return null;
    }

    await storeCallReview(supabase, workspaceId, {
      score: scored, rubric: { role: rubric.role, version: rubric.version }, target, sides,
      title, occurredAt: at, primaryEntityId: primary, accountEntityId: account, mentionEntityIds, sourceRef,
    });

    // Fire-after-scoring: the scorecard is now stored, so fan out the after-call dispatch to every
    // automation-enabled seat repo. Doing it HERE (not on meeting_held) guarantees the after-call
    // run always reads a ready score. Once per call: a re-review from a second recording skips it.
    if (!existing && dispatch) {
      try {
        await enqueueGithubDispatches(supabase, {
          workspaceId,
          eventType: 'interaction.meeting_held',
          entityId: primaryEntityId,
          occurredAt: at,
          dedupKey: target.meetingId,
          clientPayload: {
            workspace_id: workspaceId,
            event_type:   'interaction.meeting_held',
            entity_id:    primaryEntityId,
            meeting_id:   target.meetingId,
            occurred_at:  occurredAt || null,
            source:       target.source,
          },
        });
      } catch { /* dispatch is best-effort; scoring already succeeded */ }
    }
    await callAutomations(scored.summary ?? null);
    await callEnded({
      score: scored.overall ?? null,
      scores: (scored.scores ?? []).map(d => ({ dimension: d.key, score: d.score, note: d.note || null })),
    });

    return scored;
  } catch (err) {
    console.warn('[call-score] scoring failed', err?.message ?? err);
    return null;
  }
}

/**
 * A second note-taker's recording of a call that is already on the timeline (GET-246). It used to be
 * dropped without a trace. Now: it is logged, its transcript is kept in the meeting notes (once) so
 * the agent can read it, and it joins the call's review and page. Timeline and extraction still run
 * once per call, from the first recording.
 */
export async function recordSecondRecording(supabase, workspaceId, {
  source, meetingId, title, url = null, contacts, occurredAt, notesContent, transcript,
  hostUserId = null, recorder = null, namedSpeakers = false, repTalkShare = null,
}) {
  const sourceRef = `source://${source}/${meetingId}`;
  try {
    if (notesContent && contacts?.[0]) {
      const { count } = await supabase.from('claims').select('entity_id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId).eq('value->metadata->>source_ref', sourceRef);
      if (!count) {
        await saveDocument(supabase, workspaceId, {
          entityId: contacts[0].id,
          type:     'meeting_notes',
          title:    `Meeting notes — ${title || 'Meeting'}`,
          content:  notesContent,
          date:     occurredAt,
          source,
          meta:     { source_ref: sourceRef, meeting_id: meetingId, url: url || null, owner_user_id: hostUserId ?? null },
        }).catch(() => {});
      }
    }
  } catch { /* the notes are a nicety; the review below still runs */ }

  await logSysEvent(supabase, {
    workspaceId, source, eventType: 'webhook_received',
    summary:  `${title || 'Meeting'}: another recording of a call already on the timeline — kept its transcript and added it to the call`,
    metadata: { meeting_id: meetingId, duplicate_recording: true },
  }).catch(() => {});

  if (transcript && transcript.length >= 200) {
    await scoreCall({
      supabase, workspaceId, transcript, repUserId: hostUserId, meetingId, source, occurredAt,
      title, sourceUrl: url, sourceRef, contacts, recorder, namedSpeakers, repTalkShare,
    });
  }
}
