import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayReadWorkspace, forgetCreditGate } from '../src/lib/creditGate.mjs';

// The gate stands in front of every read. Everything here is about the ways it must NOT
// stop a workspace: the cost of a false stop is a customer's product going quiet, and the
// cost of a false allow is a few conversations we were not going to be paid for.

const WS = '11111111-1111-1111-1111-111111111111';
const reset = () => { forgetCreditGate(WS); delete process.env.WORKER_INTERNAL_SECRET; delete process.env.API_URL; };

test('no internal channel configured reads exactly as before', async () => {
  reset();
  const r = await mayReadWorkspace(WS);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, null);
  assert.equal(r.untilStop, null, 'no known stop, so nothing caps a batch');
});

test('a missing workspace id is allowed, not stopped', async () => {
  reset();
  assert.equal((await mayReadWorkspace(null)).allowed, true);
  assert.equal((await mayReadWorkspace(undefined)).allowed, true);
});

test('an unreachable api allows the read', async () => {
  reset();
  process.env.WORKER_INTERNAL_SECRET = 's';
  process.env.API_URL = 'http://127.0.0.1:1';   // nothing listens here
  const r = await mayReadWorkspace(WS);
  assert.equal(r.allowed, true, 'a billing lookup failing must never pause the product');
  reset();
});

test('only an explicit false stops a read', async () => {
  reset();
  process.env.WORKER_INTERNAL_SECRET = 's';
  const original = globalThis.fetch;
  try {
    for (const body of [{}, { allowed: true }, { allowed: 'no' }, null]) {
      process.env.API_URL = 'http://example.invalid';
      globalThis.fetch = async () => ({ ok: true, json: async () => body });
      forgetCreditGate(WS);
      assert.equal((await mayReadWorkspace(WS)).allowed, true, JSON.stringify(body));
    }
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ allowed: false, reason: 'over_credit_limit' }) });
    forgetCreditGate(WS);
    const stopped = await mayReadWorkspace(WS);
    assert.equal(stopped.allowed, false);
    assert.equal(stopped.reason, 'over_credit_limit');
  } finally {
    globalThis.fetch = original;
    reset();
  }
});

test('the answer is cached, so a backfill asks once and not once per thread', async () => {
  reset();
  process.env.WORKER_INTERNAL_SECRET = 's';
  process.env.API_URL = 'http://example.invalid';
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ allowed: false, reason: 'no_plan' }) }; };
    forgetCreditGate(WS);
    for (let i = 0; i < 50; i++) await mayReadWorkspace(WS);
    assert.equal(calls, 1, '50 conversations, one question');
  } finally {
    globalThis.fetch = original;
    reset();
  }
});
