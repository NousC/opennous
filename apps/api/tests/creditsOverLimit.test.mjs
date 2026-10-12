// Over the allowance (GET-733): how long until reading pauses, at this period's pace.
//
// Run: node --test apps/api/tests/creditsOverLimit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysUntilStop } from '../src/routes/api/billing.mjs';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const start = '2026-09-19T12:00:00Z'; // 16 days in

test('days left at the period\'s average pace', () => {
  // 1,040 used in 16 days = 65 a day; 112 left before 120% of 960 (1,152) → 1 day.
  assert.equal(daysUntilStop({ used: 1040, untilStop: 112, periodStart: start }, NOW), 1);
  assert.equal(daysUntilStop({ used: 320, untilStop: 832, periodStart: start }, NOW), 41);
});

test('already stopped is 0; nothing used or nothing that stops is null', () => {
  assert.equal(daysUntilStop({ used: 1200, untilStop: 0, periodStart: start }, NOW), 0);
  assert.equal(daysUntilStop({ used: 0, untilStop: 1152, periodStart: start }, NOW), null);
  assert.equal(daysUntilStop({ used: 50, untilStop: null, periodStart: start }, NOW), null);
});
