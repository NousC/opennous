// Closing a task is one edit on every surface (GET-830): the Tasks page, the bulk route and the
// public API all go through statusValue. The pure halves.
//
// Run: node --test packages/core/test/taskStatus.test.mjs   (after `tsc`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskId, taskIdOf, statusValue, planBulk, applyBulkStatus } from '../dist/services/taskStatus.mjs';

const ACC = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-10-11T12:00:00.000Z';

test('a task id is <uuid>:action_item.*, nothing else', () => {
  assert.deepEqual(parseTaskId(`${ACC}:action_item.meeting_m1_0`), { entityId: ACC, property: 'action_item.meeting_m1_0' });
  assert.equal(taskIdOf(ACC, 'action_item.x'), `${ACC}:action_item.x`);
  for (const bad of [null, '', 'action_item.x', `${ACC}:title`, `not-a-uuid:action_item.x`, `${ACC}:action_item.${'x'.repeat(300)}`]) {
    assert.equal(parseTaskId(bad), null, String(bad));
  }
});

test('done by hand is the page tick; a reason replaces the stock line', () => {
  const prev = { title: 'Send the deck', status: 'open', quote: 'I will send the deck' };
  assert.deepEqual(statusValue(prev, 'done', NOW), {
    ...prev, status: 'done', completed_at: NOW, completed_reason: 'you marked it done', completed_by: 'user',
    completed_evidence: null, reopened_at: null,
  });
  assert.equal(statusValue(prev, 'done', NOW, { reason: '  deck sent\n10 Oct ' }).completed_reason, 'deck sent 10 Oct');
  assert.equal(statusValue(prev, 'done', NOW, { reason: '   ' }).completed_reason, 'you marked it done');
});

test('reopening a closed task stamps reopened_at and clears the close', () => {
  const v = statusValue({ title: 'x', status: 'done', completed_by: 'auto', completed_evidence: { id: 'e' } }, 'open', NOW);
  assert.equal(v.status, 'open');
  assert.equal(v.reopened_at, NOW);
  assert.equal(v.completed_by, null);
  assert.deepEqual(v.completed_evidence, { id: 'e' });
});

test('planBulk: one result per id, writes only for rows that exist', () => {
  const asked = [`${ACC}:action_item.a`, 'junk', `${ACC}:action_item.missing`].map((id) => ({ id, parsed: parseTaskId(id) }));
  const rows = [{ id: 'c1', entity_id: ACC, property: 'action_item.a', value: { title: 'A', status: 'open' } }];
  const { writes, results } = planBulk(asked, rows, 'done', NOW, { reason: 'sent' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value.completed_reason, 'sent');
  assert.deepEqual(results.map((r) => r.error ?? 'ok'), ['ok', 'invalid_id', 'not_found']);
});

test('applyBulkStatus with claimRows touches only those rows and runs the hook', async () => {
  const updates = [];
  const supabase = { from: () => ({ update: (patch) => ({ eq: () => ({ eq: async () => { updates.push(patch.value); return { error: null }; } }) }) }) };
  const hooked = [];
  const asked = [`${ACC}:action_item.a`, `${ACC}:action_item.hidden`].map((id) => ({ id, parsed: parseTaskId(id) }));
  const claimRows = [{ id: 'c1', entity_id: ACC, property: 'action_item.a', value: { title: 'A', status: 'open' } }];
  const results = await applyBulkStatus(supabase, 'ws', asked, 'done', { claimRows, onWritten: async (w) => { hooked.push(w.id); } });
  assert.deepEqual(results.map((r) => r.ok), [true, false]);
  assert.equal(results[1].error, 'not_found');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, 'done');
  assert.deepEqual(hooked, [`${ACC}:action_item.a`]);
});
