import { test } from 'node:test';
import assert from 'node:assert/strict';

// The sweep's judgement, extracted: what counts as a difference worth writing. The HTTP
// route is thin around this, and this is the part that can corrupt a row.

const iso = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);

function diff(row, facts) {
  const out = {};
  for (const [k, v] of Object.entries(facts)) {
    if (v === null || v === undefined) continue;
    const mine = row[k] ?? null;
    const same = k.startsWith('current_period')
      ? mine && Date.parse(mine) === Date.parse(v)
      : String(mine) === String(v);
    if (!same) out[k] = v;
  }
  return out;
}

test('agreement writes nothing', () => {
  const row = { status: 'active', quantity: 1, cancel_at_period_end: false, current_period_end: '2026-10-14T18:36:21.453Z' };
  const facts = { status: 'active', quantity: 1, cancel_at_period_end: false, current_period_end: '2026-10-14T18:36:21.453Z' };
  assert.deepEqual(diff(row, facts), {});
});

test('a status Stripe changed and we missed is corrected', () => {
  // The whole reason this exists: a canceled subscription still reading because the webhook
  // was lost.
  assert.deepEqual(diff({ status: 'active' }, { status: 'canceled' }), { status: 'canceled' });
});

test('the same instant written two ways is not a difference', () => {
  // 1792002981 is 2026-10-14T18:36:21Z. Getting this wrong by a day is how I found out the
  // comparison works: it correctly called two different instants different.
  // Postgres and Stripe format timestamps differently; comparing strings would rewrite every
  // row every night and bury a real change in the noise.
  const row = { current_period_end: '2026-10-14T18:36:21.453463+00:00' };
  assert.deepEqual(diff(row, { current_period_end: iso(1792002981.453) }), {});
});

test('a blank from Stripe never erases what we hold', () => {
  const row = { stripe_price_id: 'price_123', status: 'active' };
  assert.deepEqual(diff(row, { stripe_price_id: null, status: undefined }), {});
});

test('false is a value, not an absence', () => {
  // cancel_at_period_end going true → false is a real correction, and a falsy check would
  // have skipped it.
  assert.deepEqual(diff({ cancel_at_period_end: true }, { cancel_at_period_end: false }), { cancel_at_period_end: false });
});

test('a quantity change is caught even though both sides are numbers', () => {
  assert.deepEqual(diff({ quantity: 1 }, { quantity: 5 }), { quantity: 5 });
});
