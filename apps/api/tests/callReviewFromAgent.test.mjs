// A call review written by the revenue plugin arrives through `record` (GET-260). What the server
// can check without a database: which attendees it names, and that a review which is not a sales call
// or does not match the rubric is refused before anything is stored.
//
// Run: node --test apps/api/tests/callReviewFromAgent.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewAttendeeEmails, recordCallReviewFromAgent } from '../src/lib/callReviewFromAgent.mjs';

// A client that answers the rubric lookup (no stored rubric → the default) and fails any write.
const db = {
  from(table) {
    const q = {
      select: () => q, eq: () => q, in: () => Promise.resolve({ data: [] }),
      maybeSingle: () => Promise.resolve({ data: null }),
      upsert: () => { throw new Error(`unexpected write to ${table}`); },
    };
    return q;
  },
};

test('attendee emails are lowercased, de-duplicated, and strings or objects both work', () => {
  assert.deepEqual(
    reviewAttendeeEmails({ attendees: [{ email: 'Rowan@Harborline.example', name: 'Rowan' }, 'rowan@harborline.example', { name: 'no email' }, 'nadia@harborline.example'] }),
    ['rowan@harborline.example', 'nadia@harborline.example'],
  );
});

test('a review missing its identity is invalid', async () => {
  const r = await recordCallReviewFromAgent(db, 'w', { value: { review: { call_type: 'sales' } } });
  assert.equal(r.status, 'invalid');
});

test('a call the reviewer calls internal is not stored', async () => {
  const r = await recordCallReviewFromAgent(db, 'w', { value: { source: 'granola', meeting_id: 'not_1', review: { call_type: 'internal' } } });
  assert.equal(r.status, 'not_sales');
});

test('a review whose dimensions do not match the rubric is refused with the keys to use', async () => {
  const r = await recordCallReviewFromAgent(db, 'w', { value: {
    source: 'granola', meeting_id: 'not_1',
    review: { call_type: 'sales', dimensions: [{ key: 'discovery_depth', score: 7, note: 'old rubric' }] },
  } });
  assert.equal(r.status, 'unusable');
  assert.deepEqual(r.expected_keys, ['discovery', 'rapport', 'objection_handling', 'demo', 'close', 'talk_listen']);
});
