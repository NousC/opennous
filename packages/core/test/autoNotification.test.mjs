// A machine's notification is not evidence of a commitment (GET-423). Quotes are invented, in the shapes calendars send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAutoNotification } from '../dist/text/autoNotification.js';

test('a calendar notification is a machine talking', () => {
  for (const q of [
    'Quentin Harrowby has accepted this invitation.',
    'Bram Oakhurst has accepted this invitation.',
    'Selwyn Tarrant has declined this invitation.',
    'Imogen Vale has tentatively accepted this invitation.',
    'This is an automated message, do not reply to this email.',
  ]) assert.equal(isAutoNotification(q), true, q);
});

test('a person agreeing a time is not — the prompt handles those, not this guard', () => {
  for (const q of [
    'Yes, I will attend.',
    'Lets say 3pm today.  Thanks!',
    'ok for 2:30 pm',
    'I can make Friday at 10AM work at the Larkfield store.',
    'I accepted the invite and will bring the numbers.',
    '',
  ]) assert.equal(isAutoNotification(q), false, JSON.stringify(q));
});
