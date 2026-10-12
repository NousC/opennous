// Calendar event rules — who a meeting is with, and what it counts as (GET-221).
//
// The fixture is the invite that exposed the bug: "Harborline.example x OpenNous", organised by a
// teammate on a personal Gmail (the gmail.com addresses below are obviously fake local parts —
// the test needs real gmail.com semantics for a personal-mailbox organiser), with the calendar owner and two Harborline guests. It never
// reached the graph. These pin the parts of that decision that need no database.
//
// Run: node --test apps/worker/tests/calendarEvent.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCalendarEvent, externalAttendees, meetingKind, isNonHumanEmail, emailDomainOf, likeEscape, calendarListArgs,
} from '../src/utils/calendarEvent.mjs';

const HARBORLINE = {
  kind: 'calendar#event',
  id: '5r0v2k9harborline',
  status: 'confirmed',
  summary: 'Harborline.example x OpenNous',
  start: { dateTime: '2026-09-14T13:00:00-04:00' },
  end: { dateTime: '2026-09-14T14:00:00-04:00' },
  organizer: { email: 'test.teammate.0001@gmail.com' },
  attendees: [
    { email: 'test.teammate.0001@gmail.com', organizer: true, responseStatus: 'accepted' },
    { email: 'Test.Owner.0002@Gmail.com', self: true, responseStatus: 'accepted' },
    { email: 'corwin@harborline.example', responseStatus: 'needsAction' },
    { email: 'rowan@harborline.example', responseStatus: 'needsAction' },
  ],
};

test('normalizes the Google event shape the Composio list action returns', () => {
  const e = normalizeCalendarEvent(HARBORLINE);
  assert.equal(e.id, '5r0v2k9harborline');
  assert.equal(e.summary, 'Harborline.example x OpenNous');
  assert.equal(e.start, '2026-09-14T17:00:00.000Z');
  assert.equal(e.allDay, false);
  assert.equal(e.selfEmail, 'test.owner.0002@gmail.com', 'the calendar owner comes from self:true, lowercased');
  assert.equal(e.organizerEmail, 'test.teammate.0001@gmail.com');
  assert.equal(e.attendees.length, 4);
});

test('the organizer counts as an attendee even when not in the guest list', () => {
  const e = normalizeCalendarEvent({ ...HARBORLINE, attendees: [{ email: 'corwin@harborline.example' }], organizer: { email: 'rowan@harborline.example' } });
  assert.deepEqual(e.attendees.map(a => a.email).sort(), ['corwin@harborline.example', 'rowan@harborline.example']);
  assert.equal(e.attendees.find(a => a.email === 'rowan@harborline.example').organizer, true);
});

test('an event with no id or no start is not an event', () => {
  assert.equal(normalizeCalendarEvent({ ...HARBORLINE, id: undefined }), null);
  assert.equal(normalizeCalendarEvent({ id: 'x', status: 'cancelled' }), null);
  assert.equal(normalizeCalendarEvent(null), null);
});

test('flattened shapes still parse', () => {
  const e = normalizeCalendarEvent({ event_id: 'f1', start_time: '2026-09-20T10:00:00Z', attendees: ['a@b.example'] });
  assert.equal(e.id, 'f1');
  assert.equal(e.attendees[0].email, 'a@b.example');
});

test('all-day events are flagged', () => {
  assert.equal(normalizeCalendarEvent({ id: 'd', start: { date: '2026-09-20' } }).allDay, true);
});

test('externals exclude the owner (self), our team, and machines', () => {
  const e = normalizeCalendarEvent({
    ...HARBORLINE,
    attendees: [...HARBORLINE.attendees, { email: 'noreply@calendly.com' }, { email: 'room-4@resource.calendar.google.com' }],
  });
  const people = externalAttendees(e, { internal: new Set(['test.teammate.0001@gmail.com']) });
  assert.deepEqual(people.map(p => p.email).sort(), ['corwin@harborline.example', 'rowan@harborline.example']);
});

test('a colleague on our work domain is ours even before they are seated', () => {
  const e = normalizeCalendarEvent({ id: 'w', start: { dateTime: '2026-09-20T10:00:00Z' },
    attendees: [{ email: 'new.hire@opennous.example' }, { email: 'buyer@acme.example' }] });
  const people = externalAttendees(e, { internalDomains: new Set(['opennous.example']) });
  assert.deepEqual(people.map(p => p.email), ['buyer@acme.example']);
});

test('the connection email excludes the owner when Google sends no self flag', () => {
  const e = normalizeCalendarEvent({ id: 's', start: { dateTime: '2026-09-20T10:00:00Z' },
    attendees: [{ email: 'test.owner.0002@gmail.com' }, { email: 'buyer@acme.example' }] });
  assert.deepEqual(externalAttendees(e, { ownEmail: 'test.owner.0002@gmail.com' }).map(p => p.email), ['buyer@acme.example']);
});

test('meeting kind: upcoming is scheduled, past + accepted is held, declined stays scheduled', () => {
  const e = normalizeCalendarEvent(HARBORLINE);
  const before = new Date('2026-09-13T12:00:00Z').getTime();
  const after = new Date('2026-09-15T12:00:00Z').getTime();
  const guest = e.attendees.find(a => a.email === 'rowan@harborline.example');

  assert.deepEqual(meetingKind(e, guest, before), { type: 'meeting_scheduled', label: '(Scheduled)' });
  assert.deepEqual(meetingKind(e, { ...guest, responseStatus: 'accepted' }, after), { type: 'meeting_held', label: '(Held)' });
  assert.equal(meetingKind(e, guest, after).type, 'meeting_scheduled', 'never said yes → not counted as held');
  assert.equal(meetingKind(e, { ...guest, organizer: true }, after).type, 'meeting_held', 'they organised it → they came');
  assert.deepEqual(meetingKind(e, { ...guest, responseStatus: 'declined' }, before), { type: 'meeting_scheduled', label: '(Declined)' });
});

test('non-human addresses', () => {
  assert.equal(isNonHumanEmail('no-reply@zoom.us'), true);
  assert.equal(isNonHumanEmail('anyone@calendly.com'), true);
  assert.equal(isNonHumanEmail('rowan@harborline.example'), false);
  assert.equal(isNonHumanEmail('not-an-email'), true);
});

test('list args carry the camelCase names Composio documents, so singleEvents is not ignored', () => {
  const a = calendarListArgs({ timeMin: 't0', timeMax: 't1', maxResults: 50, pageToken: 'p2' });
  assert.equal(a.calendarId, 'primary');
  assert.equal(a.singleEvents, true);
  assert.equal(a.showDeleted, true);
  assert.equal(a.pageToken, 'p2');
  assert.equal(a.maxResults, 50);
  assert.equal(calendarListArgs({ timeMin: 't0', timeMax: 't1' }).pageToken, undefined);
});

test('helpers', () => {
  assert.equal(emailDomainOf('Rowan@Harborline.example'), 'harborline.example');
  assert.equal(emailDomainOf('nope'), null);
  assert.equal(likeEscape('gcal_a%b_'), 'gcal\\_a\\%b\\_');
});
