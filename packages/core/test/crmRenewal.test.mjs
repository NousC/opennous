// When a customer next decides whether to stay, read from what they are billed on.
//
// Run: ./packages/core/node_modules/.bin/tsc -p packages/core && node --test packages/core/test/crmRenewal.test.mjs
//
// The risk is not a wrong date by a day. It is the renewals list becoming the whole book (a
// month-to-month customer given a renewal 30 days out), or a real annual renewal vanishing because
// one subscription read came back without it. Shapes below follow a real portal's; the dates are invented.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renewalFromSubscriptions, renewalChanges } from '../dist/integrations/crm/accountHealth.js';

const TODAY = new Date('2026-10-02T15:00:00Z');
const sub = (status, start, end, frequency = 'monthly', extra = {}) => ({ status, start, end, frequency, ...extra });

test('a month-to-month customer has no renewal date, and says so', () => {
  // HubSpot re-dates a monthly subscription every cycle: start 09-11, end 10-11. That is billing,
  // not a commitment, and most of a portal's active subscriptions look exactly like this.
  const r = renewalFromSubscriptions([sub('active', '2026-09-11', '2026-10-11'), sub('active', '2025-08-20', null)], TODAY);
  assert.deepEqual(r, { renewalDate: null, termMonths: 1, live: true });
});

test('a 12-month term renews at its end', () => {
  const r = renewalFromSubscriptions([sub('active', '2025-11-17', '2026-11-16')], TODAY);
  assert.deepEqual(r, { renewalDate: '2026-11-16', termMonths: 12, live: true });
});

test('an intro term that rolls into a scheduled year renews at the end of the year, not the intro', () => {
  // "Starter bundle": 3 months from Aug 1, then a scheduled 9 months from Nov 1.
  const r = renewalFromSubscriptions([
    sub('active', '2026-08-01', '2026-10-31'),
    sub('scheduled', '2026-11-01', '2027-07-31'),
    sub('active', '2026-09-08', '2026-10-08'),          // a monthly add-on alongside
  ], TODAY);
  assert.equal(r.renewalDate, '2027-07-31');
  assert.equal(r.termMonths, 12);
});

test('the nearest of two separate commitments is the renewal', () => {
  const r = renewalFromSubscriptions([
    sub('active', '2026-05-19', '2027-05-18'),
    sub('active', '2025-12-02', '2026-12-01'),
  ], TODAY);
  assert.equal(r.renewalDate, '2026-12-01');
});

test('an end that has already passed is HubSpot behind, not a renewal', () => {
  const r = renewalFromSubscriptions([sub('active', '2025-06-16', '2026-06-15')], TODAY);
  assert.equal(r.renewalDate, null);
  assert.equal(r.live, true);
});

test('cancelled and expired subscriptions are not a contract', () => {
  const r = renewalFromSubscriptions([
    sub('canceled', '2026-03-12', '2027-03-11'),
    sub('expired', '2025-05-07', '2026-05-06'),
  ], TODAY);
  assert.deepEqual(r, { renewalDate: null, termMonths: null, live: false });
});

test('an evergreen subscription billed yearly renews on its next payment', () => {
  const r = renewalFromSubscriptions([sub('active', '2025-12-01', null, 'annually', { nextPaymentDue: '2026-12-01' })], TODAY);
  assert.equal(r.renewalDate, '2026-12-01');
  assert.equal(r.termMonths, 12);
});

test('dates arrive in more than one shape and a bad one is ignored, not guessed', () => {
  const ms = String(Date.UTC(2027, 3, 14));
  assert.equal(renewalFromSubscriptions([sub('active', '2026-04-15T00:00:00Z', ms)], TODAY).renewalDate, '2027-04-14');
  assert.equal(renewalFromSubscriptions([sub('active', 'soon', 'later')], TODAY).renewalDate, null);
});

test('only what changed is written, and a date that no longer holds is cleared', () => {
  const annual = { renewalDate: '2026-11-16', termMonths: 12, live: true };
  assert.deepEqual(renewalChanges(annual, {}), [['cs.renewal_date', '2026-11-16'], ['cs.term_months', 12]]);
  // Same facts already on the account: nothing to append.
  assert.deepEqual(renewalChanges(annual, { renewal_date: '2026-11-16', term_months: 12 }), []);
  // The annual ended and they stayed monthly: the stale date is cleared ('' — a null observation
  // is ignored by the claim engine), the term becomes 1.
  assert.deepEqual(renewalChanges({ renewalDate: null, termMonths: 1, live: true }, { renewal_date: '2026-11-16', term_months: 12 }),
    [['cs.renewal_date', ''], ['cs.term_months', 1]]);
  // Nothing live and nothing ever written: a prospect gets no health bag from this.
  assert.deepEqual(renewalChanges({ renewalDate: null, termMonths: null, live: false }, {}), []);
  // A claim value that arrives wrapped compares by its inner value.
  assert.deepEqual(renewalChanges(annual, { renewal_date: { value: '2026-11-16' }, term_months: { value: 12 } }), []);
});
