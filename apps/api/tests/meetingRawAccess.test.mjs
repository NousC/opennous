// GET-286: a transcript belongs to the people who were in the call. The claims drawn out of it
// belong to the company — those are not gated here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canReadMeetingRaw } from '@nous/core';

const rep = { userId: 'u-rhea', emails: new Set(['rhea@harborline.example']), isAdmin: false };
const other = { userId: 'u-mel', emails: new Set(['ines@harborline.example']), isAdmin: false };
const admin = { userId: 'u-rowan', emails: new Set(['rowan@harborline.example']), isAdmin: true };

test('the host reads their own call, a colleague does not', () => {
  const meta = { owner_user_id: 'u-rhea', host_email: 'rhea@harborline.example' };
  assert.equal(canReadMeetingRaw(meta, rep), true);
  assert.equal(canReadMeetingRaw(meta, other), false, "a colleague's call is not yours to read");
  assert.equal(canReadMeetingRaw(meta, admin), true, 'an admin runs the workspace');
});

test('the host is known by email even before they hold a seat', () => {
  // What a company note-taker files: the host email is on the call, the seat is not yet.
  const meta = { owner_user_id: null, host_email: 'rhea@harborline.example' };
  assert.equal(canReadMeetingRaw(meta, rep), true);
  assert.equal(canReadMeetingRaw(meta, other, { open: false }), false);
});

test('a call nobody has claimed follows the workspace dial', () => {
  const meta = { owner_user_id: null, host_email: null };
  assert.equal(canReadMeetingRaw(meta, other, { open: true }), true);
  assert.equal(canReadMeetingRaw(meta, other, { open: false }), false);
});

test('an attendee reads the call they were in', () => {
  const meta = { owner_user_id: 'u-rhea', attendee_emails: ['ines@harborline.example'] };
  assert.equal(canReadMeetingRaw(meta, other), true);
});

test('a system job reads everything', () => {
  assert.equal(canReadMeetingRaw({ owner_user_id: 'u-rhea' }, null), true);
});
