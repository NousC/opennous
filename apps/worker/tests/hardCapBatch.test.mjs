// Free's 500 is a stop, not a band (GET-700). One "yes" used to buy a whole batch of up to 400
// threads (800 credits); the gate's cache served a stale yes for five minutes; and an outage
// reopened a cap we had already measured as spent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CREDIT_SCALE } from '@nous/core';
import { mayReadWorkspace, noteCreditsSpent, forgetCreditGate, HARD_CAP_NEAR_CREDITS } from '../src/lib/creditGate.mjs';
import { readWorkspace, RECHECK_EVERY } from '../src/workers/emailThreadsDaily.mjs';

const WS = '22222222-2222-2222-2222-222222222222';

async function withApi(answers, fn) {
  const original = globalThis.fetch;
  process.env.WORKER_INTERNAL_SECRET = 's';
  process.env.API_URL = 'http://example.invalid';
  let calls = 0;
  globalThis.fetch = async () => {
    const a = answers[Math.min(calls, answers.length - 1)];
    calls++;
    if (a instanceof Error) throw a;
    return { ok: true, json: async () => a };
  };
  forgetCreditGate(WS);
  try { return await fn(() => calls); } finally {
    globalThis.fetch = original;
    forgetCreditGate(WS);
    delete process.env.WORKER_INTERNAL_SECRET;
    delete process.env.API_URL;
  }
}

test('the gate passes on how much is left before a hard stop', async () => {
  await withApi([{ allowed: true, hardCap: true, untilStop: 300 }], async () => {
    const g = await mayReadWorkspace(WS);
    assert.deepEqual(g, { allowed: true, reason: null, hardCap: true, untilStop: 300 });
  });
});

test('spending down to zero turns the cached yes into a no, with no api call', async () => {
  await withApi([{ allowed: true, hardCap: true, untilStop: 4 }], async (calls) => {
    await mayReadWorkspace(WS);
    noteCreditsSpent(WS, 4);
    // Near the cap a yes would be re-asked; a no is served from cache.
    const g = await mayReadWorkspace(WS);
    assert.equal(g.allowed, false);
    assert.equal(calls(), 1);
  });
});

test('near a hard cap a cached yes is not served', async () => {
  await withApi([{ allowed: true, hardCap: true, untilStop: HARD_CAP_NEAR_CREDITS - 1 }], async (calls) => {
    await mayReadWorkspace(WS);
    await mayReadWorkspace(WS);
    await mayReadWorkspace(WS);
    assert.equal(calls(), 3, 'every check asks again near the cap');
  });
  await withApi([{ allowed: true, hardCap: true, untilStop: 400 }], async (calls) => {
    for (let i = 0; i < 5; i++) await mayReadWorkspace(WS);
    assert.equal(calls(), 1, 'far from the cap the cache still holds');
  });
});

test('a known-exhausted hard cap stays shut through an outage', async () => {
  await withApi([{ allowed: false, reason: 'over_credit_limit', hardCap: true, untilStop: 0 }, new Error('down')], async () => {
    assert.equal((await mayReadWorkspace(WS)).allowed, false);
    const g = await mayReadWorkspace(WS, { fresh: true });
    assert.equal(g.allowed, false, 'an unreachable api does not reopen a spent cap');
  });
});

test('a failed meter count is no answer: a spent cap stays shut, an unknown one stays open', async () => {
  await withApi([{ allowed: false, hardCap: true, untilStop: 0 }, { allowed: true, hardCap: true, untilStop: 500, meterError: true }], async () => {
    await mayReadWorkspace(WS);
    assert.equal((await mayReadWorkspace(WS, { fresh: true })).allowed, false);
  });
  await withApi([{ allowed: true, hardCap: true, untilStop: 500, meterError: true }], async () => {
    assert.equal((await mayReadWorkspace(WS)).allowed, true, 'fails open with no measurement');
  });
});

test('an outage with no prior answer still fails open', async () => {
  await withApi([new Error('down')], async () => {
    assert.equal((await mayReadWorkspace(WS)).allowed, true);
  });
});

// readWorkspace with the database and the model stubbed out: N due threads, each read costs
// CREDIT_SCALE, the gate is a scripted function.
function harness(dueCount, gateAnswers) {
  const due = Array.from({ length: dueCount }, (_, i) => ({ key: `t${i}` }));
  let left = null;
  const asks = [];
  const deps = {
    threadsToRead: async () => ({ due, externalIds: new Set(), reread: 0, skippedThreads: [] }),
    hydrateThreadBodies: async () => {},
    selectEmailThreads: ({ threads }) => ({ units: [...threads.values()], skippedThreads: [] }),
    markThreadSkipped: async () => {},
    readGmailThread: async () => ({ facts: [], commitments: [] }),
    mayReadWorkspace: async (_ws, opts = {}) => {
      asks.push(opts.fresh ? 'fresh' : 'cached');
      const a = gateAnswers(asks.length, left);
      if (typeof a.untilStop === 'number') left = a.untilStop;
      return a;
    },
    noteCreditsSpent: (_ws, n) => { if (left != null) left = Math.max(0, left - n); },
  };
  return { deps, asks, get left() { return left; } };
}

test('Free with 100 credits left reads 50 threads of 400 due, and leaves the rest unmarked', async () => {
  const h = harness(400, (n, left) => ({ allowed: (left ?? 100) > 0, reason: null, hardCap: true, untilStop: left ?? 100 }));
  const stats = await readWorkspace({}, WS, { deps: h.deps });
  assert.equal(stats.read, 100 / CREDIT_SCALE);
  assert.equal(stats.deferred, 400 - 100 / CREDIT_SCALE);
  assert.equal(stats.paused, 'over_credit_limit');
  assert.equal(h.asks[1], 'fresh', 'a hard cap is asked fresh before the batch is sized');
});

test('a re-check mid-batch stops reading when something else spent the rest', async () => {
  // Starts with 400 credits left; at the first re-check the api says the cap is spent.
  const h = harness(200, (n) => (n <= 2
    ? { allowed: true, reason: null, hardCap: true, untilStop: 400 }
    : { allowed: false, reason: 'over_credit_limit', hardCap: true, untilStop: 0 }));
  const stats = await readWorkspace({}, WS, { concurrency: 1, deps: h.deps });
  assert.equal(stats.read, RECHECK_EVERY);
  assert.equal(stats.paused, 'over_credit_limit');
  assert.equal(stats.deferred, 200 - RECHECK_EVERY);
});

test('a plan with no known stop reads the batch as before', async () => {
  const h = harness(30, () => ({ allowed: true, reason: null, hardCap: false, untilStop: null }));
  const stats = await readWorkspace({}, WS, { deps: h.deps });
  assert.equal(stats.read, 30);
  assert.equal(stats.paused, undefined);
});

test('an exhausted cap reads nothing', async () => {
  const h = harness(30, () => ({ allowed: false, reason: 'over_credit_limit', hardCap: true, untilStop: 0 }));
  const stats = await readWorkspace({}, WS, { deps: h.deps });
  assert.equal(stats.read, 0);
  assert.equal(stats.paused, 'over_credit_limit');
});
