// An email that has not been sent is not filed (GET-964).
//
// A Gmail scheduled send sits in the outbox with its planned send time. The scan filed it then, as a
// sent email stamped hours ahead: written at 01:45, "sent" at 11:17. Everything that reads an
// email's time saw the future (the thread reader re-read the thread every hour until 11:17). A draft
// or a scheduled message is skipped; the scan's window picks it up once it is really sent.
//
// Run: node --test apps/worker/tests/gmailNotSentYet.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notSentYet } from '../src/webhooks/handlers/composio.mjs';

const now = Date.parse('2026-10-15T01:45:00Z');

test('a scheduled send or a draft is not filed yet', () => {
  assert.equal(notSentYet({ labels: ['SCHEDULED'], occurredAt: '2026-10-15T11:17:00Z', now }), 'scheduled');
  assert.equal(notSentYet({ labels: ['DRAFT'], occurredAt: '2026-10-15T01:40:00Z', now }), 'draft');
});

test('an email stamped well in the future is not filed, whatever its labels say', () => {
  // The list call does not always carry labels; a time hours ahead is the outbox all the same.
  assert.equal(notSentYet({ labels: [], occurredAt: '2026-10-15T11:17:00Z', now }), 'future');
});

test('a sent or received email is filed, clock skew of a few minutes included', () => {
  assert.equal(notSentYet({ labels: ['SENT'], occurredAt: '2026-10-15T01:44:10Z', now }), null);
  assert.equal(notSentYet({ labels: ['INBOX', 'UNREAD'], occurredAt: '2026-10-15T01:49:00Z', now }), null);
  assert.equal(notSentYet({ labels: [], occurredAt: null, now }), null);
});
