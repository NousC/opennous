// The backfill's three windows (GET-514): 12 months imported, 3 months read, tasks from 30 days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writesTasks, TASKS_AFTER_DAYS, BACKFILL_READ_DAYS } from '../dist/services/meetingPolicy.js';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

test('the windows are 30 days of tasks inside 90 days of reading', () => {
  assert.equal(TASKS_AFTER_DAYS, 30);
  assert.equal(BACKFILL_READ_DAYS, 90);
});

test('a conversation files tasks only in the last 30 days', () => {
  assert.equal(writesTasks(daysAgo(1), NOW), true);
  assert.equal(writesTasks(daysAgo(30), NOW), true);
  assert.equal(writesTasks(daysAgo(31), NOW), false);
  assert.equal(writesTasks(daysAgo(80), NOW), false);
});

test('a missing, unreadable or future date files tasks rather than silently dropping them', () => {
  assert.equal(writesTasks(null, NOW), true);
  assert.equal(writesTasks('not a date', NOW), true);
  assert.equal(writesTasks(daysAgo(-3), NOW), true);
});
