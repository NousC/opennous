// A meeting is one thing that happened, so its notes are one record.
//
// They used to be written inside the per-contact loop, so a five-person call stored the same large
// blob five times — around ten copies per meeting on average — and across a full backfill that
// would have become tens of thousands of rows that are not claims, in the table every rollup reads.
//
// Run: node --test apps/worker/tests/meetingNotesSubject.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetingNotesSubject } from '../src/webhooks/handlers/fellow.mjs';

const ext = (id) => ({ contactId: id });

test('the account wins whenever we know it', () => {
  // The same rule the call page follows. Notes filed on the person who happened to be first in the
  // room hide a meeting that belongs to the customer.
  assert.equal(
    meetingNotesSubject({ accountEntityId: 'co1', externals: [ext('p1'), ext('p2')], internals: ['u1'] }),
    'co1',
  );
});

test('a person is the subject only when the account is unknown', () => {
  assert.equal(meetingNotesSubject({ accountEntityId: null, externals: [ext('p1'), ext('p2')] }), 'p1');
});

test('an internal person never takes a customer meeting', () => {
  // This is the bug that filed calls onto the seller's own employees. An internal attendee is the
  // subject only when there was no external attendee at all — an internal-only call.
  assert.equal(
    meetingNotesSubject({ accountEntityId: null, externals: [ext('p1')], internals: ['u1'] }),
    'p1',
  );
  assert.equal(
    meetingNotesSubject({ accountEntityId: null, externals: [], internals: ['u1'] }),
    'u1',
    'an internal-only call still deserves its notes somewhere',
  );
});

test('nobody at all is null, not a crash and not a guess', () => {
  assert.equal(meetingNotesSubject({}), null);
  assert.equal(meetingNotesSubject({ accountEntityId: null, externals: [], internals: [] }), null);
  assert.equal(meetingNotesSubject(), null);
});

test('one meeting yields one subject regardless of how many people were in it', () => {
  // The whole point: the answer does not scale with the size of the room.
  const many = Array.from({ length: 12 }, (_, i) => ext(`p${i}`));
  assert.equal(meetingNotesSubject({ accountEntityId: 'co1', externals: many }), 'co1');
  assert.equal(meetingNotesSubject({ accountEntityId: null, externals: many }), 'p0');
});
