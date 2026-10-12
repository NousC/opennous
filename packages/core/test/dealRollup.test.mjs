// Deal rollup — reducing a company's CRM deals to the one set of numbers the forecast reads.
//
// This is where the money enters the forecast, so the rules matter: open deals SUM (an
// account with two live deals contributes both), won deals are history and never forecast,
// lost deals contribute nothing, and an unrecognised stage is treated as closed rather than
// open because inflating a forecast is worse than understating it.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/dealRollup.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crmDealState, rollupDeals } from '../dist/services/dealRollup.js';

// ── classifying one deal ─────────────────────────────────────────────────────

test("the provider's own status beats the stage label", () => {
  // Pipedrive ships open|won|lost explicitly. A customer who renamed a stage to something
  // containing "won" must not flip a genuinely open deal.
  assert.equal(crmDealState({ status: 'open', stage: 'Renewal Won Back' }), 'open');
  assert.equal(crmDealState({ status: 'won', stage: 'Negotiation' }), 'won');
  assert.equal(crmDealState({ status: 'lost', stage: 'Negotiation' }), 'lost');
  assert.equal(crmDealState({ status: 'deleted', stage: 'Negotiation' }), 'lost');
});

test('HubSpot stage ids classify without a status field', () => {
  assert.equal(crmDealState({ stage: 'closedwon' }), 'won');
  assert.equal(crmDealState({ stage: 'closedlost' }), 'lost');
  assert.equal(crmDealState({ stage: 'appointmentscheduled' }), 'open');
  assert.equal(crmDealState({ stage: 'contractsent' }), 'open');
});

test('spelling and punctuation do not change the answer', () => {
  for (const v of ['Closed Won', 'closed-won', 'CLOSED_WON', 'closedwon']) {
    assert.equal(crmDealState({ stage: v }), 'won', v);
  }
  for (const v of ['Closed Lost', 'closed-lost', 'Churned', 'Disqualified', 'Abandoned']) {
    assert.equal(crmDealState({ stage: v }), 'lost', v);
  }
});

test('an unnamed "closed" outcome counts as lost, not open', () => {
  // The conservative call. Reading it as open would quietly add money to the forecast that
  // nobody believes is coming.
  assert.equal(crmDealState({ stage: 'Closed' }), 'lost');
});

test('a missing stage is treated as open', () => {
  assert.equal(crmDealState({}), 'open');
  assert.equal(crmDealState({ stage: null }), 'open');
});

// ── rolling a company's deals up ─────────────────────────────────────────────

test('open deals are SUMMED, not max-ed', () => {
  // The behaviour this replaces took MAX of a per-contact value, which dropped a third of
  // this account's pipeline on the floor.
  const r = rollupDeals([
    { value: 50000, currency: '$', stage: 'negotiation', close_date: '2026-10-15' },
    { value: 30000, currency: '$', stage: 'discovery', close_date: '2026-11-30' },
  ]);
  assert.equal(r.openAmount, 80000);
  assert.equal(r.openDeals, 2);
});

test('the close date is the EARLIEST open deal — what could land soonest', () => {
  const r = rollupDeals([
    { value: 10, stage: 'discovery', close_date: '2026-12-01' },
    { value: 10, stage: 'discovery', close_date: '2026-09-15' },
    { value: 10, stage: 'discovery', close_date: '2026-10-20' },
  ]);
  assert.equal(r.closeDate, '2026-09-15');
});

test('won deals are counted separately and never enter the open figure', () => {
  const r = rollupDeals([
    { value: 40000, stage: 'closedwon', close_date: '2026-01-10' },
    { value: 25000, stage: 'negotiation', close_date: '2026-10-01' },
  ]);
  assert.equal(r.openAmount, 25000, 'a won deal leaked into open pipeline');
  assert.equal(r.wonAmount, 40000);
  assert.equal(r.openDeals, 1);
  assert.equal(r.wonDeals, 1);
});

test("a won deal's close date never becomes the forecast date", () => {
  // Its close date is in the past. Letting it win would forecast money that already landed.
  const r = rollupDeals([
    { value: 40000, stage: 'closedwon', close_date: '2020-01-01' },
    { value: 25000, stage: 'negotiation', close_date: '2026-10-01' },
  ]);
  assert.equal(r.closeDate, '2026-10-01');
});

test('lost deals contribute nothing at all', () => {
  const r = rollupDeals([
    { value: 90000, stage: 'closedlost' },
    { value: 15000, stage: 'discovery' },
  ]);
  assert.equal(r.openAmount, 15000);
  assert.equal(r.wonAmount, null);
  assert.equal(r.openDeals, 1);
});

test('an all-lost account rolls up to nothing, not to zero-with-confidence', () => {
  const r = rollupDeals([{ value: 90000, stage: 'closedlost' }]);
  assert.equal(r.openAmount, null);
  assert.equal(r.closeDate, null);
  assert.equal(r.openDeals, 0);
});

test('no deals rolls up to nulls', () => {
  const r = rollupDeals([]);
  assert.equal(r.openAmount, null);
  assert.equal(r.wonAmount, null);
  assert.equal(r.openDeals, 0);
});

test('mixed currencies are FLAGGED, never summed', () => {
  // We hold no FX rates. Adding dollars to euros would produce a confident wrong number,
  // so the caller is told to leave the amount unset instead.
  const r = rollupDeals([
    { value: 50000, currency: '$', stage: 'discovery' },
    { value: 30000, currency: '€', stage: 'discovery' },
  ]);
  assert.equal(r.mixedCurrency, true);
});

test('one currency throughout is not flagged', () => {
  const r = rollupDeals([
    { value: 50000, currency: '€', stage: 'discovery' },
    { value: 30000, currency: '€', stage: 'discovery' },
  ]);
  assert.equal(r.mixedCurrency, false);
  assert.equal(r.currency, '€');
  assert.equal(r.openAmount, 80000);
});

test('a deal with no amount still counts as an open deal', () => {
  // The count and the money are different facts. An account with a live deal and no number
  // on it is not an account with no deal.
  const r = rollupDeals([{ stage: 'discovery', close_date: '2026-10-01' }]);
  assert.equal(r.openDeals, 1);
  assert.equal(r.openAmount, null);
  assert.equal(r.closeDate, '2026-10-01');
});

test('junk entries do not blow up the rollup', () => {
  const r = rollupDeals([null, undefined, { value: 'not-a-number', stage: 'discovery' }, { value: 100, stage: 'discovery' }]);
  assert.equal(r.openAmount, 100);
  assert.equal(r.openDeals, 2);
});
