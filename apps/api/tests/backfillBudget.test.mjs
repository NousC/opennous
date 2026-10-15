import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDITS_PER_UNIT, UNIT_COST_USD, BACKFILL_CEILING_USD,
  creditsForMeeting, ceilingUsdForPlan, estimateBackfill, backfillAllowanceForPlan,
  projectCreditsFromRecords, checkBackfillBudget,
} from '../src/lib/backfillBudget.mjs';

// The gate that prices a backfill before it runs. The rule is not a dollar ceiling: the
// backfill has to fit inside the plan's own monthly credit allowance, because a workspace
// whose last 30 days holds more than its plan sells in a month is on the wrong plan.
//
// Pure functions — the DB half is a thin count around these. Expected numbers come from
// docs/unit-economics.md, so a failure means the model moved and the doc needs re-deriving.

test('a meeting bills at one credit per 10 minutes, and never zero', () => {
  assert.equal(creditsForMeeting(30), 6, 'the measured median, at CREDIT_SCALE = 2');
  assert.equal(creditsForMeeting(45), 10);
  assert.equal(creditsForMeeting(60), 12);
  assert.equal(creditsForMeeting(4), 2, 'a four-minute call is still a read');
  assert.equal(creditsForMeeting(undefined), CREDITS_PER_UNIT.meeting, 'falls back to the median');
  assert.equal(creditsForMeeting(0), CREDITS_PER_UNIT.meeting);
});

test('a note is read-free and therefore credit-free', () => {
  assert.equal(CREDITS_PER_UNIT.note, 0);
  assert.equal(UNIT_COST_USD.note, 0);
  const e = estimateBackfill({ note: 5000 });
  assert.equal(e.credits, 0, 'notes cannot push a workspace over its plan');
  assert.equal(e.usd, 0);
});

test('ceilings are dollars, and Custom has none', () => {
  assert.equal(ceilingUsdForPlan('api'), 25);
  assert.equal(ceilingUsdForPlan('custom'), null);
  assert.equal(ceilingUsdForPlan('custom'), null, 'the volume is what we quoted on');
  // Retired ids resolve before they reach the table.
  assert.equal(ceilingUsdForPlan('pro'), 25);
  assert.equal(ceilingUsdForPlan('headless'), null, 'the operated family is quoted');
  // An unknown plan gets the strictest ceiling, not the loosest.
  assert.equal(ceilingUsdForPlan('something-we-have-not-shipped'), BACKFILL_CEILING_USD.api);
  assert.equal(ceilingUsdForPlan(undefined), BACKFILL_CEILING_USD.api);
});

test('a known set of conversations prices exactly, and unpriceable types are ignored', () => {
  const e = estimateBackfill({ meeting: 10, email_thread: 100, call: 50, banana: 9999 });
  assert.equal(e.credits, 360); // (10×3 + 100 + 50) × 2
  assert.equal(e.usd, 1.775); // 10×0.061 + 100×0.0048 + 50×0.0137
  assert.equal(e.byType.meeting.credits, 60);
  assert.equal(e.byType.banana, undefined, 'the banana is not a conversation');
});

test('an empty or nonsense count is free, not NaN', () => {
  assert.equal(estimateBackfill({}).credits, 0);
  assert.equal(estimateBackfill({ meeting: -5, call: 'lots' }).credits, 0);
  assert.equal(projectCreditsFromRecords(0), 0);
  assert.equal(projectCreditsFromRecords(null), 0);
});

test('an ordinary month is well under the ceiling, so the customer just confirms it', () => {
  const r = checkBackfillBudget({ planId: 'api', counts: { email_thread: 1700, call: 200, meeting: 100 } });
  assert.equal(r.credits, 4400); // (1700 + 200 + 300) × 2
  assert.equal(r.basis, 'counted');
  assert.equal(r.ok, true);
  assert.equal(r.needsSupport, false);
  assert.ok(r.estimateUsd < 25, `got $${r.estimateUsd}`);
});

test('the backfill allowance, in credits, is the line between two questions (GET-515)', () => {
  // Self-serve reads 3,000 conversations of history on us — 6,000 credits at CREDIT_SCALE = 2
  // (GET-545: matches the $25 ceiling).
  // Custom has no line, because the volume is what we quoted on.
  assert.equal(backfillAllowanceForPlan('api'), 6_000);
  assert.equal(backfillAllowanceForPlan('custom'), null);
  const under = checkBackfillBudget({ planId: 'api', counts: { email_thread: 3_000 } });
  assert.equal(under.needsSupport, false, 'the customer can start this themselves');
  assert.equal(under.allowance, 6_000);
  const over = checkBackfillBudget({ planId: 'api', counts: { email_thread: 3_001 } });
  assert.equal(over.needsSupport, true);
  assert.equal(over.reason, 'over_allowance');
  assert.equal(over.ok, false);
  assert.equal(checkBackfillBudget({ planId: 'api', counts: { email_thread: 7_000, meeting: 400 } }).needsSupport, true); // 16,400 credits
});

test('a very large workspace goes to a conversation on every plan but Custom', () => {
  // A month of a large workspace.
  const counts = { email_thread: 10000, call: 4000, meeting: 600, note: 1000 };
  for (const planId of ['api', 'pro', 'starter', 'free']) {
    const r = checkBackfillBudget({ planId, counts });
    assert.equal(r.needsSupport, true, `${planId} should not start a workspace this size on its own`);
    assert.ok(r.estimateUsd > 100, `got $${r.estimateUsd}`);
  }
  const custom = checkBackfillBudget({ planId: 'custom', counts });
  assert.equal(custom.needsSupport, false, 'Custom is quoted against its own volume');
  assert.equal(custom.ceilingUsd, null);
  assert.ok(custom.estimateUsd > 100, 'but it is still priced — the preview shows it either way');
});

test('with no activities yet it projects from records and says so', () => {
  const r = checkBackfillBudget({ planId: 'pro', recordCount: 100000 });
  assert.equal(r.basis, 'projected');
  assert.equal(r.credits, 38000); // 100,000 × 0.19 × 2
  assert.equal(r.needsSupport, true);

  const small = checkBackfillBudget({ planId: 'api', recordCount: 2000 });
  assert.equal(small.basis, 'projected');
  assert.equal(small.needsSupport, false, '2,000 records is a normal workspace');
});

test('counts win over records whenever we have them', () => {
  // A huge dormant CRM with almost no conversations should run: most of a long-lived CRM's records
  // have no activity at all, so records alone would hold the wrong people.
  const r = checkBackfillBudget({ planId: 'api', counts: { email_thread: 200 }, recordCount: 100000 });
  assert.equal(r.basis, 'counted');
  assert.equal(r.needsSupport, false);
});

test('a shorter window projects proportionally fewer credits', () => {
  const thirty = checkBackfillBudget({ planId: 'api', recordCount: 10000, windowDays: 30 });
  const ten = checkBackfillBudget({ planId: 'api', recordCount: 10000, windowDays: 10 });
  assert.equal(ten.credits, Math.round(thirty.credits / 3));
});

test('every plan the code can sell has an entry', () => {
  for (const planId of ['api', 'custom']) {
    assert.ok(Object.hasOwn(BACKFILL_CEILING_USD, planId), `${planId} needs an entry`);
  }
});

test('the estimate carries a per-type breakdown, because the preview names what it found', () => {
  const r = checkBackfillBudget({ planId: 'api', counts: { meeting: 120, email_thread: 800 } });
  assert.equal(r.byType.meeting.conversations, 120);
  assert.equal(r.byType.meeting.credits, 720, 'a meeting is six credits at CREDIT_SCALE = 2');
  assert.equal(r.byType.email_thread.conversations, 800);
  assert.ok(r.byType.meeting.usd > 0 && r.byType.email_thread.usd > 0);
});

test('self-host prices a backfill as Custom (no allowance, no ceiling) whatever the subscription (GET-850)', async () => {
  const { backfillPlanId } = await import('../src/lib/historyBackfill.mjs');
  assert.equal(backfillPlanId({ plan_id: 'free', status: 'active' }, { selfHosted: true }), 'custom');
  assert.notEqual(backfillPlanId({ plan_id: 'api', status: 'active' }, { selfHosted: false }), 'custom');
});
