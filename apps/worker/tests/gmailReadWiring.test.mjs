// Two things the Gmail Read must actually DO, not merely contain.
//
// Both of these shipped broken, in the same way: a patch whose search string no longer matched,
// applied cleanly, changed nothing, and left a function that existed and was never called. Nothing
// errored. The run reported every thread read and 0 failed, and it was telling the truth — it just had
// no opinion about whether the marker was written or the calls were metered.
//
//   markThreadRead  defined, called nowhere → every thread read and none marked, so every one of them
//                   would be bought again on the next pass
//   onCall          absent from extractFactsFromText → the claim calls never reached llm_usage, so
//                   a run's recorded cost was about half its real cost, and every per-thread
//                   estimate quoted from it was half the truth
//
// A unit test cannot catch this without a database, and the failure is structural rather than
// behavioural, so it is checked structurally — the same tactic as modelDoorGuard, which fails the
// build when a file constructs a provider SDK directly.
//
// Run: node --test apps/worker/tests/gmailReadWiring.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/noema/gmailRead.mjs', import.meta.url), 'utf8');

/** Lines that USE a name, ignoring the line that defines or exports it. */
function callSites(src, name) {
  return src.split('\n').filter(l =>
    l.includes(`${name}(`) &&
    !/^\s*(export\s+)?(async\s+)?function\s/.test(l) &&
    !l.trim().startsWith('*') &&
    !l.trim().startsWith('//'));
}

test('markThreadRead is called, not just defined', () => {
  assert.ok(SRC.includes('export async function markThreadRead'), 'it should still exist');
  assert.ok(callSites(SRC, 'markThreadRead').length > 0,
    'markThreadRead is defined and never called — every thread read would be re-bought');
});

test('the marker is written for every read, not only when facts came back', () => {
  // It has to sit outside any `if (facts.length)` style guard: a thread that yielded nothing was
  // still read, and that is the case the claims-based marker could not represent.
  const call = callSites(SRC, 'markThreadRead')[0] ?? '';
  assert.ok(!/facts\.length|commitments\.length/.test(call),
    'the marker must not be conditional on what the read produced');
});

test('claim extraction reports its cost', () => {
  const block = SRC.slice(SRC.indexOf('extractFactsFromText({'), SRC.indexOf('const kept ='));
  assert.ok(block.includes('onCall:'),
    'extractFactsFromText without onCall means the claim calls never reach llm_usage');
  assert.ok(block.includes('meterLLM'), 'and onCall has to actually meter');
});

test('the insight half is wired — claims are about them, insights are about us', () => {
  // It was not. readGmailThread filed claims and commitments and never called the insight pass,
  // so every market signal, product ask and positioning correction in hundreds of threads went nowhere.
  // The meeting path has always made this call; the Gmail path simply did not have it.
  assert.ok(SRC.includes("from '../signals/insights.mjs'"), 'the extractor must be imported');
  assert.ok(callSites(SRC, 'extractCallInsights').length > 0,
    'extractCallInsights is imported and never called — the insight half is missing again');
});

test('insights read the WHOLE thread, and rest on their side', () => {
  // The model reads the whole thread: an insight about us is understood from what we wrote as well as
  // what they answered, so the transcript is never narrowed. What an insight may REST ON is narrowed
  // (GET-974): its quote is the customer's words, so it is checked against their side only. A line we
  // wrote is not their evidence about us.
  const call = SRC.slice(SRC.indexOf('extractCallInsights({'), SRC.indexOf('let commitments'));
  assert.ok(/transcript:\s*text\b/.test(call), 'the whole rendered thread is the transcript');
  assert.ok(/groundAgainst:\s*theirSideOf\(text\)/.test(call), 'the quote is checked against their side');
});

test('commitment extraction reports its cost too', () => {
  // read() meters via meterAs; this pins that it is still passed.
  assert.ok(/feature: 'gmail-thread-commitments'[\s\S]{0,200}meterAs:/.test(SRC),
    'the commitment Read must carry meterAs or its calls are unmetered');
});

test('the Read tells loadOurSide which activity it is reading', () => {
  // Without an activityId, loadOurSide falls back to soleTeamSpeaker, which looks for
  // transcript-style "Name:" lines. A rendered thread has "--- us · addr · day ---" headers and
  // never those, so ownerName was always null and every prompt said "our team" — and every
  // commitment was filed with nobody to do it. Hundreds of tasks, no owners.
  const call = SRC.slice(SRC.indexOf('loadOurSide('), SRC.indexOf('const ourName'));
  assert.ok(call.includes('activityId'), 'loadOurSide must be given an activityId, not text alone');
});

test('every filed task is ours, and a chase records who we are waiting on', () => {
  // Was: "a customer's promise never names one of our people as its owner" — because a
  // prospect-owned row would nag a rep for work that was never theirs. GET-425 removes the
  // situation instead of guarding it: a commitment the customer owes is turned round into OUR
  // follow-up, so every row is ours and naming the rep is correct. What must not be lost is who
  // we are waiting on, which is what makes the row readable as a chase rather than a deliverable.
  assert.match(SRC, /owner_kind:\s*'user',/, 'every task filed here is ours');
  assert.doesNotMatch(SRC, /owner_kind:\s*owner\b/, 'the model\'s side must not become the row\'s owner');
  assert.match(SRC, /awaiting_them: theirs \|\| null/, 'a chase is flagged');
  assert.match(SRC, /owed_by:\s*theirs \? theirName : null/, 'and names who owes it');
});

test('a marker failure is counted, not only warned', () => {
  // It lives in a .catch, so a run logs clean whether or not the marker landed. A thread read but
  // not marked is one that will be bought a second time.
  assert.ok(SRC.includes('export let markerFailures'), 'the count has to be readable by the runner');
  assert.match(SRC.slice(SRC.indexOf('read marker failed') - 120, SRC.indexOf('read marker failed') + 60),
    /markerFailures\+\+/, 'the catch must increment it');
});

test('the marker is looked up by equality, never a prefix LIKE', () => {
  // A per-thread property made the lookup `property LIKE 'noema.read.gmail_%'`, and a prefix LIKE
  // on property cannot use the btree index under the default collation: parallel seq scan, hundreds of
  // thousands of rows filtered, seconds to return nothing. Looped by pageAll it blew the statement timeout and
  // killed the calibration run before it read a thread.
  //
  // Index Scan, a handful of buffers, milliseconds with equality. Idempotency moves to external_id, which
  // observations_dedup already enforces as UNIQUE (workspace_id, source, external_id) — a better
  // guard than a deterministic string, because the database holds it.
  assert.ok(SRC.includes("property: 'noema.read'"), 'one constant property');
  assert.ok(/externalId:\s*`\$\{SOURCE\}_\$\{threadId\(thread\)\}`/.test(SRC),
    'the thread goes in external_id, where the unique index can see it');
  assert.ok(!/property:\s*`noema\.read\.\$\{/.test(SRC), 'never back to a per-thread property');
});

// A thread is filed against the first counterpart that can BE a subject (GET-397).
//
// It used to take externalIds[0] and give up if that record had no name. Long threads died that
// way — a dozen messages, thousands of characters, several people on them, most of whom had
// perfectly good names (Lena Quist, Corwin Ashdale, Sabeline Kroft…).
// Position zero happened to be one of a few nameless records, so the conversation was dropped on
// an accident of ordering, silently, counted in the run's output as "read".
//
// Structural for the same reason as the rest of this file: choosing the subject needs a database.
test('the subject is searched for, not assumed to be first', () => {
  const body = SRC.slice(SRC.indexOf('export async function readGmailThread'));
  const block = body.slice(0, body.indexOf('loadOurSide'));

  assert.doesNotMatch(block, /const contactId = thread\.externalIds\?\.\[0\]/,
    'taking position zero discards a thread whenever that record happens to be nameless');
  assert.match(block, /for \(const id of thread\.externalIds\)/,
    'it has to walk the counterparts');
  assert.match(block, /if \(candidate\?\.name\)/,
    'and stop at the first one that can carry a claim');
});

test('a thread with no named counterpart at all still says why it was skipped', () => {
  // The skip reason is the only trace a dropped thread leaves. "subject has no name" described
  // one record; "no named counterpart" describes the thread, which is what was actually judged.
  assert.match(SRC, /skipped: 'no named counterpart'/);
  assert.doesNotMatch(SRC, /skipped: 'subject has no name'/,
    'the old reason named the wrong thing and would now be a lie');
});
