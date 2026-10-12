// What a call earns: a health read, a coaching review, or neither.
//
// The invariant worth pinning is one line wide: `skipCoaching` withholds the REP GRADE and
// nothing else. A history import is run to build the account record, so a business review must
// still produce its page, its standing and its risk and expansion claims even when the run has
// asked not to be charged for coaching. Move the skip one branch earlier and a backfill would
// silently stop building health — with no error, just an empty CS tab.
//
// Pure: no database, no model, no network.
//
// Run: node --test apps/worker/tests/callPlan.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callPlan } from '../src/signals/callScore.mjs';

test('a customer call is READ, and skipping coaching does not change that', () => {
  for (const type of ['business_review', 'training']) {
    assert.equal(callPlan(type), 'health_read');
    assert.equal(callPlan(type, { skipCoaching: true }), 'health_read',
      `${type} must still be read when coaching is skipped — this is the account record, not a grade`);
  }
});

test('a sales call is graded normally, and skipped on request', () => {
  assert.equal(callPlan('discovery'), 'coach');
  assert.equal(callPlan('demo'), 'coach');
  assert.equal(callPlan('discovery', { skipCoaching: true }), 'skip');
  assert.equal(callPlan('demo', { skipCoaching: true }), 'skip');
});

test('a call nobody grades is skipped either way', () => {
  // internal, investor, recruiting, unknown — never a coaching moment to begin with.
  for (const type of ['internal', 'other', 'nonsense']) {
    assert.equal(callPlan(type), 'skip');
    assert.equal(callPlan(type, { skipCoaching: true }), 'skip');
  }
});

test('the default is to coach: only a caller that asked gets the cheaper run', () => {
  assert.equal(callPlan('discovery', {}), 'coach');
  assert.equal(callPlan('discovery', { skipCoaching: false }), 'coach');
  assert.equal(callPlan('discovery', undefined), 'coach');
});
