// Who owes whom a reply (GET-255) — from the order of touches, not a reply's sentiment.
//
// Run: node --test apps/worker/tests/replyOwed.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyOwedFromTouches, touchDirection } from '@nous/core';

const t = (property, observed_at, is_outbound) => ({ property, observed_at, is_outbound });

test('a busy Harborline thread in one day: answered by Avery, nothing owed', () => {
  const rows = [
    t('interaction.email_sent', '2026-09-08T09:10:00Z', true),
    t('interaction.email_received', '2026-09-08T09:25:00Z', false),
    t('interaction.email_received', '2026-09-08T14:05:00Z', false),
    t('interaction.email_sent', '2026-09-08T14:20:00Z', true),
    t('interaction.email_received', '2026-09-08T14:21:00Z', false),
    t('interaction.email_sent', '2026-09-08T14:22:00Z', true),   // Avery's reaction
    t('interaction.email_sent', '2026-09-08T16:45:00Z', true),   // a follow-up, Rowan on cc
  ];
  assert.equal(replyOwedFromTouches(rows).owed_since, null);
});

test('their message after our last one is owed since it arrived', () => {
  const rows = [
    t('interaction.email_sent', '2026-09-01T10:00:00Z', true),
    t('interaction.email_received', '2026-09-02T09:00:00Z', false),
    t('interaction.email_received', '2026-09-03T09:00:00Z', false),
  ];
  assert.equal(replyOwedFromTouches(rows).owed_since, '2026-09-02T09:00:00Z');
});

test('a LinkedIn reply or a meeting after their email answers it', () => {
  assert.equal(replyOwedFromTouches([
    t('interaction.email_received', '2026-09-02T09:00:00Z', false),
    t('interaction.linkedin_message', '2026-09-02T12:00:00Z', 'true'),
  ]).owed_since, null);
  assert.equal(replyOwedFromTouches([
    t('interaction.email_received', '2026-09-02T09:00:00Z', false),
    t('interaction.meeting_held', '2026-09-03T12:00:00Z', null),
  ]).owed_since, null);
});

test('rows arrive in any order', () => {
  const rows = [
    t('interaction.email_sent', '2026-09-05T10:00:00Z', true),
    t('interaction.email_received', '2026-09-04T09:00:00Z', false),
  ];
  assert.equal(replyOwedFromTouches(rows).owed_since, null);
});

test('directions', () => {
  assert.equal(touchDirection(t('interaction.linkedin_message', 'x', false)), 'in');
  assert.equal(touchDirection(t('interaction.linkedin_message', 'x', null)), null);
  assert.equal(touchDirection(t('interaction.email_received', 'x', null)), 'in');
  assert.equal(touchDirection(t('interaction.email_opened', 'x', null)), null);
  assert.equal(touchDirection(t('interaction.positive_reply', 'x', null)), 'in');
});
