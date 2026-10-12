// What a call or an email asked us to do becomes a task, once (GET-786).
//
// A customer call ended with three things on our side: book the Friday follow-up, set up an
// automation that posts the account's daily activity to Slack, and work through the CS motions the
// customer described. None became a task. The prompts dropped all three on purpose: "meeting
// logistics of any kind", "never turn a plan for the product into a task", and a bar of "someone
// said I will". The same week, one call read twice filed the same task twice.
//
// These pin the rules that change that, and the two guards that keep it from going wrong the
// other way: the source call never closes its own "book the follow-up", and a repeat is dropped.
//
// Run: node --test packages/core/test/taskCoverage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealthReadPrompt, buildCommitmentsPrompt, parseCommitmentsJson, parseHealthReadJson } from '../dist/services/accountHealth.js';
import { repeatsFiledTask } from '../dist/db/meetingTaskClosure.js';
import { meetingCameAfter, BOOKING_TITLE } from '../dist/services/actionItems.js';
import { promisedAtOf } from '../dist/services/actionItemClosure.mjs';

const T = 'Fernpoint: can you set the Slack summary up? Avery: yes, and I will book us Friday.';

test('both meeting prompts file the next meeting, building something for the customer, and what the customer asked for', () => {
  for (const prompt of [buildHealthReadPrompt(T), buildCommitmentsPrompt(T)]) {
    assert.match(prompt, /Arranging the NEXT meeting IS a commitment/);
    assert.match(prompt, /work our side agreed to do FOR this customer IS a commitment/);
    assert.match(prompt, /When the customer asks our side to do, build, fix or change something/);
    // The logistics of a meeting already set stay out.
    assert.match(prompt, /confirming or moving a time already set/);
    assert.doesNotMatch(prompt, /meeting logistics of any kind/);
    assert.match(prompt, /commitments: 0–8 items/);
  }
});

test('a busy call keeps eight commitments, not five', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ text: `Task ${i}`, quote: '', owner: 'us', due: '' }));
  assert.equal(parseCommitmentsJson(JSON.stringify({ commitments: many })).length, 8);
  const h = parseHealthReadJson(JSON.stringify({ summary: 'A call.', standing: 'neutral', risks: many, expansion: [], commitments: many }));
  assert.equal(h.commitments.length, 8);
  assert.equal(h.risks.length, 5, 'risks keep their own cap');
});

const row = (title, source_id, occurred_at, source_type = 'meeting') => ({ value: { title, source_id, occurred_at, source_type } });

test('the same call read from a second recording does not file its task again', () => {
  const onRecord = [row('Focus the first section on what to know for onboarding, with recent and critical insights', 'm-granola-1', '2026-10-01T15:00:00Z')];
  const title = 'Focus first section on "What to know for onboarding" with recent and critical insights';
  assert.equal(repeatsFiledTask(onRecord, { title, sourceId: 'm-granola-2', at: '2026-10-01T15:05:00Z' }), true);
  // The same meeting re-read overwrites its own rows; that is not a repeat.
  assert.equal(repeatsFiledTask(onRecord, { title, sourceId: 'm-granola-1', at: '2026-10-01T15:00:00Z' }), false);
  // The same words a week later is a new promise.
  assert.equal(repeatsFiledTask(onRecord, { title, sourceId: 'm-granola-3', at: '2026-10-09T15:00:00Z' }), false);
  // A different task on the same call is not a repeat.
  assert.equal(repeatsFiledTask(onRecord, { title: 'Reformat the account history as dated bullet points', sourceId: 'm-granola-2', at: '2026-10-01T15:05:00Z' }), false);
});

test('two different tasks that share a verb and a name are not one task', () => {
  const at = '2026-10-01T15:00:00Z';
  const pairs = [
    ['Follow up with Dorian on the signed contract', 'Follow up with Dorian on the invoice'],
    ['Marisol to send Dorian the setup guide', 'Marisol to send Dorian the pricing guide'],
    ['Follow up with Dorian', 'Follow up with Dorian on the security questionnaire'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(repeatsFiledTask([row(a, 'm-1', at)], { title: b, sourceId: 'm-2', at }), false, `${a} / ${b}`);
  }
});

test('an email or a typed task is never a repeat of a call task', () => {
  const at = '2026-10-01T15:00:00Z';
  const title = 'Send Dorian the revised proposal';
  assert.equal(repeatsFiledTask([row(title, 'thread-1', at, 'email')], { title, sourceId: 'm-2', at }), false);
  assert.equal(repeatsFiledTask([row(title, 'manual', at, 'manual')], { title, sourceId: 'm-2', at }), false);
});

test('a promise to book a meeting is told apart from a promise to write', () => {
  for (const t of ['Book the Friday session with Dana to go through the motions list', 'Schedule the follow-up call with Dorian', 'Avery to book the onboarding session', 'Set up a call with Dorian on the rollout']) {
    assert.match(t, BOOKING_TITLE, t);
  }
  for (const t of ['Follow up with Dorian on the contract', 'Send Dana the recap of the call', 'Set up the automation that posts the daily summary to Slack']) {
    assert.doesNotMatch(t, BOOKING_TITLE, t);
  }
});

test('the call a "book the follow-up" was said on never closes it', () => {
  const said = '2026-10-07T18:00:00Z';
  // The call's own meeting_held is stamped at its start.
  assert.equal(meetingCameAfter(said, '2026-10-07T18:00:00Z'), false);
  assert.equal(meetingCameAfter(said, '2026-10-07T18:40:00Z'), false);
  // A meeting booked or held later does.
  assert.equal(meetingCameAfter(said, '2026-10-09T16:00:00Z'), true);
  // No time on either side keeps the old rule.
  assert.equal(meetingCameAfter(undefined, '2026-10-07T18:00:00Z'), true);
  assert.equal(meetingCameAfter(said, null), true);
});

test('the Tasks-page closer still dates a promise from when it was said', () => {
  const at = promisedAtOf({ value: { occurred_at: '2026-10-07T18:00:00Z' } });
  assert.equal(at, Date.parse('2026-10-07T18:00:00Z') - 2 * 60_000);
});
