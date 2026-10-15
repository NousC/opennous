// Only a customer proves that two recordings are one call.
//
// The match was "any shared contact within three hours". Our own staff are on every call, so on
// one afternoon two different customers' installation calls were merged: Thistlecombe Health (pim,
// orla, tobin) and Ashcombe Systems (quill, marrc, tobyh), sharing nobody except lena@harborline.example,
// the CS manager who ran both that afternoon. They became one record with one page, and the page
// alternated between the two customers on every re-run.
//
// Run: node --test packages/core/test/callTargetMatch.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCallTarget } from '../dist/services/callReviewStore.js';

/** Captures the entity ids the scorecard lookup actually matched on. */
function stub() {
  const seen = { ids: null, queried: false };
  const q = {
    select: () => q, eq: () => q, gte: () => q, lte: () => q, neq: () => q, order: () => q,
    in: (_col, ids) => { seen.queried = true; seen.ids = ids; return q; },
    limit: () => Promise.resolve({ data: [], error: null }),
  };
  return { client: { from: () => q }, seen };
}

const CALL = {
  meetingId: 'Tq3vNw8KeB', source: 'fellow', occurredAt: '2026-08-19T15:00:00Z',
  sides: null, hostUserId: null,
  contacts: [
    { id: 'lena', email: 'lena@harborline.example' },      // ours — on every call
    { id: 'quill',  email: 'quill@ashcombesystems.example' },
    { id: 'marrc',  email: 'marrc@ashcombesystems.example' },
  ],
};

test('the match uses only the external participants it was given', async () => {
  const { client, seen } = stub();
  await resolveCallTarget(client, 'ws', { ...CALL, matchContactIds: ['quill', 'marrc'] });
  assert.deepEqual(seen.ids, ['quill', 'marrc']);
  assert.ok(!seen.ids.includes('lena'), 'our own person must never be the evidence');
});

test('with no external participant, no merge is even attempted', async () => {
  const { client, seen } = stub();
  const target = await resolveCallTarget(client, 'ws', { ...CALL, matchContactIds: [] });
  assert.equal(seen.queried, false);   // an internal-only call cannot be "another recording" of anything
  assert.equal(target.existing, null);
  assert.equal(target.meetingId, 'Tq3vNw8KeB');
});

test('a caller that cannot tell the sides apart behaves exactly as before', async () => {
  const { client, seen } = stub();
  await resolveCallTarget(client, 'ws', CALL);          // no matchContactIds
  assert.deepEqual(seen.ids, ['lena', 'quill', 'marrc']);
});

test('no existing call means this recording stands on its own', async () => {
  const { client } = stub();
  const target = await resolveCallTarget(client, 'ws', { ...CALL, matchContactIds: ['quill'] });
  assert.equal(target.existing, null);
  assert.equal(target.recordings.length, 1);
  assert.equal(target.recordings[0].meeting_id, 'Tq3vNw8KeB');
});
