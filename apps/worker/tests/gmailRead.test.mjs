// The Gmail Read: what it points at, what it is worth, and whose words may carry a promise.
//
// The three pure decisions the Read makes before it spends anything. Each has a failure that has
// already cost us something on the meeting path:
//
//   the source_ref  — a claim that cannot say which conversation produced it makes "have we read
//                     this" unanswerable, and a resume check impossible (GET-359)
//   the age cut     — a commitment from a thread that went quiet in March lands five months
//                     overdue in a rep's queue
//   the quote side  — a promise attributed to them, quoted from our own message, is a task built
//                     on words they never wrote (the section-4 guard, applied to commitments)
//
// Run: node --test apps/worker/tests/gmailRead.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadId, threadSourceRef, threadTreatment, groundCommitmentQuote, statedSideOf } from '../src/noema/gmailRead.mjs';
import { ARCHIVAL_AFTER_DAYS } from '@nous/core';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-18T00:00:00Z');
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const thread = (key, ...dates) => ({ key, messages: dates.map(d => ({ observedAt: d })) });

test('a thread_id is the id; a subject-keyed thread gets a stable hash', () => {
  assert.equal(threadId({ key: 'tid:abc123' }), 'abc123');

  const hashed = threadId({ key: 'subj:pilot|marisol@tidewell.example' });
  assert.match(hashed, /^subj-[0-9a-f]{16}$/);
  // Deterministic — this is what makes the resume check work rather than re-buy the corpus.
  assert.equal(hashed, threadId({ key: 'subj:pilot|marisol@tidewell.example' }));
  assert.notEqual(hashed, threadId({ key: 'subj:pricing|marisol@tidewell.example' }));
});

test('the source_ref is what a claim points back at', () => {
  assert.equal(threadSourceRef({ key: 'tid:abc123' }), 'source://gmail/abc123');
});

test('age is judged on the LAST message, not the first', () => {
  // The case that makes this the whole ruling: opened in March, still running this week.
  const running = thread('tid:t', at(200), at(150), at(2));
  assert.equal(threadTreatment(running, NOW), 'live');

  // Same opening date, but it died in March.
  const dead = thread('tid:t', at(200), at(195));
  assert.equal(threadTreatment(dead, NOW), 'archival');
});

test('the cut is ARCHIVAL_AFTER_DAYS itself, not a number copied next to it', () => {
  assert.equal(threadTreatment(thread('tid:t', at(ARCHIVAL_AFTER_DAYS - 1)), NOW), 'live');
  assert.equal(threadTreatment(thread('tid:t', at(ARCHIVAL_AFTER_DAYS + 1)), NOW), 'archival');
});

test('an unreadable or future date is treated as live — pay rather than silently downgrade', () => {
  assert.equal(threadTreatment(thread('tid:t', null), NOW), 'live');
  assert.equal(threadTreatment(thread('tid:t', 'not a date'), NOW), 'live');
  assert.equal(threadTreatment({ key: 'tid:t', messages: [] }, NOW), 'live');
  assert.equal(threadTreatment(thread('tid:t', new Date(NOW + 5 * DAY).toISOString()), NOW), 'live');
});

// ── the quote side ───────────────────────────────────────────────────────────

const THREAD = `--- them · marisol@tidewell.example · 2026-09-15 ---
We will get you the location list once legal signs off on it.

--- us · ezra@harborline.example · 2026-09-16 ---
As you mentioned, you'll send us the location list this week. I'll have the import fix out by Friday.`;

test("a promise attributed to THEM cannot be quoted from OUR restatement", () => {
  // The trap the guard was built for: our restatement is verbatim in the thread, which is exactly
  // what makes it dangerous. Stated by them → refused, because they never wrote it.
  const ours = "you'll send us the location list this week";
  assert.ok(groundCommitmentQuote(ours, 'us', THREAD), 'it is genuinely in the thread');
  assert.equal(groundCommitmentQuote(ours, 'them', THREAD), null, 'but they did not say it');
});

test('their own promise, in their own words, still grounds', () => {
  assert.ok(groundCommitmentQuote('We will get you the location list once legal signs off', 'them', THREAD));
});

test('our promise may be quoted from our own message', () => {
  assert.ok(groundCommitmentQuote("I'll have the import fix out by Friday", 'us', THREAD));
});

test('AN ASK WE MADE grounds on OUR sentence, though THEY owe it', () => {
  // Every ungrounded commitment in a later sample was this: "Provide the four-digit branch
  // code", "Send the signed vendor form" — owed by them, written by us. Requiring
  // their side refused every one, and the sentence was right there in our own message.
  const ask = 'Could you double-check the form fields are mapped';
  const thread = `--- them · marisol@tidewell.example · 2026-09-15 ---\nWe are seeing an issue on the signup page.\n\n--- us · ezra@harborline.example · 2026-09-16 ---\nCould you double-check the form fields are mapped before Friday.`;
  assert.equal(groundCommitmentQuote(ask, 'them', thread), null, 'refused when attributed to their side');
  assert.ok(groundCommitmentQuote(ask, 'us', thread), 'grounded on the side that actually wrote it');
});

test('who owes it and who said it are read separately', () => {
  assert.equal(statedSideOf({ stated_by: 'us' }, 'prospect'), 'us', 'an ask: they owe it, we said it');
  assert.equal(statedSideOf({ stated_by: 'them' }, 'prospect'), 'them');
  assert.equal(statedSideOf({ stated_by: 'US' }, 'user'), 'us', 'case is not a difference');
});

test('a model that omits stated_by falls back to the owner — the old behaviour', () => {
  assert.equal(statedSideOf({}, 'prospect'), 'them');
  assert.equal(statedSideOf({}, 'user'), 'us');
  assert.equal(statedSideOf({ stated_by: 'nonsense' }, 'user'), 'us');
});

test('an invented promise grounds for neither side', () => {
  const invented = 'We will waive the first year of fees entirely';
  assert.equal(groundCommitmentQuote(invented, 'us', THREAD), null);
  assert.equal(groundCommitmentQuote(invented, 'them', THREAD), null);
});

test('missing or unusable quotes are null, never thrown', () => {
  for (const q of [null, undefined, '', '   ']) {
    assert.equal(groundCommitmentQuote(q, 'us', THREAD), null);
    assert.equal(groundCommitmentQuote(q, 'them', THREAD), null);
  }
});
