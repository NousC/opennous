// A re-read replaces the last read (GET-409). The pure halves.
//
// Run: node --test packages/core/test/meetingReread.test.mjs   (after `tsc`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carriedOver, retirePreviousMeetingTasks, previousMeetingTasks } from '../dist/services/meetingReread.js';

const prev = [
  { id: 'c1', entity_id: 'acct', property: 'action_item.meeting_m1_0', value: { title: 'Send the Lumen Verify sign-up information', status: 'done', completed_by: 'user', completed_at: '2026-09-20T00:00:00Z', completed_reason: 'you marked it done' } },
  { id: 'c2', entity_id: 'acct', property: 'action_item.meeting_m1_1', value: { title: 'Reach out to Leopold', status: 'open', reopened_at: '2026-09-19T00:00:00Z' } },
  { id: 'c3', entity_id: 'barnaby', property: 'action_item.meeting_m1_2', value: { title: 'Review the emails', status: 'open' } },
];

test('a task closed by hand stays closed when the call is read again — same key', () => {
  const c = carriedOver(prev, 'acct', 'action_item.meeting_m1_0', 'Tamsin to send Barnaby the Lumen Verify signup steps');
  assert.equal(c.status, 'done');
  assert.equal(c.completed_by, 'user');
  assert.equal(c.completed_reason, 'you marked it done');
});

test('...and when the numbering moved but the title did not', () => {
  const c = carriedOver(prev, 'acct', 'action_item.meeting_m1_3', 'Send the Lumen Verify sign-up information.');
  assert.equal(c.status, 'done', 'matched on the title, punctuation aside');
});

test('a reopen keeps its line; an open task carries nothing else', () => {
  assert.deepEqual(carriedOver(prev, 'acct', 'action_item.meeting_m1_1', 'Reach out to Leopold'), { reopened_at: '2026-09-19T00:00:00Z' });
  assert.deepEqual(carriedOver(prev, 'barnaby', 'action_item.meeting_m1_2', 'Review the emails'), {});
  assert.deepEqual(carriedOver(prev, 'acct', 'action_item.meeting_m1_9', 'Something new'), {});
});

test('keys the new read did not rewrite are retired; rewritten ones are kept', async () => {
  const updated = [];
  const supabase = { from: () => ({ update: (v) => ({ in: (_col, ids) => { updated.push({ v, ids }); return Promise.resolve({ error: null }); } }) }) };
  // The new read rewrote _0 on acct and _2 on acct (moved from barnaby), and dropped _1.
  const n = await retirePreviousMeetingTasks(supabase, prev, [
    { entityId: 'acct', property: 'action_item.meeting_m1_0' },
    { entityId: 'acct', property: 'action_item.meeting_m1_2' },
  ]);
  assert.equal(n, 2);
  assert.deepEqual(updated[0].ids.sort(), ['c2', 'c3'], '_1 (dropped) and barnaby\'s _2 (moved) are stale');
  assert.ok(updated[0].v.invalid_at, 'retired by invalidation, never deleted');
});

test('nothing to retire writes nothing', async () => {
  let calls = 0;
  const supabase = { from: () => { calls++; return {}; } };
  assert.equal(await retirePreviousMeetingTasks(supabase, prev, prev.map(p => ({ entityId: p.entity_id, property: p.property }))), 0);
  assert.equal(calls, 0);
});

// ── the key range (GET-410 follow-up) ────────────────────────────────────────
//
// Under ICU collation '~' sorts before digits, so `< '…_~'` matched nothing and the previous read
// was never found — measured on prod 2026-09-21. The bound has to be a letter.
import { meetingTaskKeyRange } from '../dist/services/meetingReread.js';

test('the upper bound is a letter, so every digit-suffixed key falls inside it in any collation', () => {
  const [lo, hi] = meetingTaskKeyRange('Kx7mPq2NvT');
  assert.equal(lo, 'action_item.meeting_Kx7mPq2NvT_');
  assert.ok(/[a-z]$/.test(hi), `not '~' or any symbol: ${hi}`);
  for (const n of [0, 4, 9, 10, 27]) {
    const key = `${lo}${n}`;
    assert.ok(key >= lo && key < hi, `${key} inside [${lo}, ${hi}) by byte order`);
  }
  assert.ok(!(`action_item.meeting_Kx7mPq2NvU_0` < hi && `action_item.meeting_Kx7mPq2NvU_0` >= lo), 'another meeting stays outside');
});

test('a failed read throws instead of returning an empty list', async () => {
  const supabase = { from: () => ({ select: () => ({ eq: () => ({ gte: () => ({ lt: () => ({ is: () => ({ limit: () => Promise.resolve({ data: null, error: { message: 'canceling statement due to statement timeout' } }) }) }) }) }) }) }) };
  await assert.rejects(() => previousMeetingTasks(supabase, 'ws', 'm1'), /statement timeout/);
});
