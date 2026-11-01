// An own-plan backfill (GET-1085): every call goes to the person's model and none reaches ours, a
// long wait stops the run instead of failing the read, and a teammate's mail stays out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessage, withOwnModel, ownModelActive, ModelUnavailableError } from '@nous/core';
import { ownModelAsk } from '../src/lib/ownModelBridge.mjs';
import { threadIsTheirs, heldForOwnBackfill } from '../src/workers/emailThreadsDaily.mjs';
import { readValue } from '../src/workers/readLedger.mjs';
import { mayReadWorkspace } from '../src/lib/creditGate.mjs';
import { runOwnBackfill } from '../src/ownBackfillRun.mjs';

const door = (extra = {}) => createMessage({ feature: 'f', max_tokens: 10, system: 'sys', messages: [{ role: 'user', content: 'hi' }], ...extra });

test('inside a run the door asks the person, at no cost, and outside it does not', async () => {
  const seen = [];
  const msg = await withOwnModel(async (call) => { seen.push(call); return { text: 'yes', model: 'their-model', usage: { input_tokens: 3, output_tokens: 1 } }; }, () => door());
  assert.equal(msg.content[0].text, 'yes');
  assert.equal(msg.cost_usd, 0);
  assert.equal(seen[0].system, 'sys');
  assert.equal(seen.length, 1);
  await assert.rejects(door({ fallback: false }), (e) => !/their-model/.test(e.message));
});

test('a failed own call never falls back to our models', async () => {
  const fetched = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('reached a provider'); };
  try {
    await assert.rejects(withOwnModel(async () => { throw new Error('plan said no'); }, () => door()), (e) => e instanceof ModelUnavailableError && /plan said no/.test(e.message));
  } finally { globalThis.fetch = fetched; }
});

function fakeCalls() {
  const rows = [];
  const q = (name) => {
    const filters = {};
    let patch = null, del = false;
    const b = {
      insert(row) { const r = { id: `c${rows.length}`, status: 'pending', ...row }; rows.push(r); return { select: () => ({ single: async () => ({ data: r, error: null }) }) }; },
      select() { return b; }, eq(k, v) { filters[k] = v; return b; },
      delete() { del = true; return b; }, update(p) { patch = p; return b; },
      async maybeSingle() { return { data: rows.find(r => r.id === filters.id) ?? null }; },
      then(res) { if (del) rows.splice(rows.findIndex(r => r.id === filters.id), 1); return res({ data: null }); },
    };
    return b;
  };
  return { rows, from: q };
}
const JOB = { job_id: 'j', workspace_id: 'w', state: { own_model: { owner_user_id: 'u' } } };

test('a call waits for its answer, and the conversation text does not stay', async () => {
  const db = fakeCalls();
  const ask = ownModelAsk(db, JOB, { sleep: async () => { db.rows[0].status = 'done'; db.rows[0].answer = 'ok'; } });
  const a = await ask({ feature: 'f', system: 's', messages: [], max_tokens: 1, temperature: 0 });
  assert.equal(a.text, 'ok');
  assert.equal(db.rows.length, 0);
});

test('nobody coming back stops the run rather than failing the read', async () => {
  const db = fakeCalls();
  let t = 0, away = 0;
  const ask = ownModelAsk(db, JOB, { waitLimitMs: 10, now: () => (t += 6), sleep: async () => {}, onAway: async () => { away++; throw new Error('stopped'); } });
  await assert.rejects(ask({ feature: 'f', messages: [] }), /stopped/);
  assert.equal(away, 1);
});

test('the run reads this person only, and finishes the job', async () => {
  const updates = [];
  const job = { job_id: 'j', workspace_id: 'w', contacts: [{ id: 'a' }], window_days: 180, state: { own_model: { owner_user_id: 'u' } } };
  const cleared = [];
  const supabase = { from: (t) => {
    const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: job }), update: (p) => { updates.push(p); return b; }, delete: () => { cleared.push(t); return b; }, then: (r) => r({}) };
    return b;
  } };
  let enrichOpts, flushed = false, flushedOwn = false;
  const r = await runOwnBackfill(supabase, 'j', { sleep: async () => {}, ask: async () => ({ text: '' }), enrich: async (_s, _w, _i, _j, o) => { enrichOpts = o; }, readEmail: async () => {}, flushSummaries: async () => { flushed = true; flushedOwn = ownModelActive(); } });
  assert.equal(r, 'done');
  assert.equal(enrichOpts.ownerUserId, 'u');
  assert.equal(enrichOpts.windowDays, 180);
  assert.equal(enrichOpts.ownPlan, true);
  assert.ok(flushed && flushedOwn, "the last summaries go on the person's plan, not ours");
  assert.deepEqual(cleared, ['own_model_calls']);
  assert.equal(updates.at(-1).status, 'done');
});

test('the run waits for a read still in flight before it ends', async () => {
  const job = { job_id: 'j', workspace_id: 'w', contacts: [], state: { own_model: { owner_user_id: 'u' } } };
  const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: job }), update: () => b, delete: () => b, then: (r) => r({}) };
  const order = [];
  let release;
  const slow = new Promise(r => { release = r; });
  let sleeps = 0;
  await runOwnBackfill({ from: () => b }, 'j', {
    ask: async () => { await slow; order.push('answered'); return { text: 'x' }; },
    enrich: async () => {}, flushSummaries: async () => {},
    // Background work a read set going, not awaited by the read.
    readEmail: async () => { door().catch(() => {}); },
    sleep: async () => { if (++sleeps === 5) release(); await new Promise(r => setImmediate(r)); },
  });
  order.push('ended');
  assert.deepEqual(order, ['answered', 'ended']);
});

test('the hourly reader leaves an open job its history, and keeps new mail', () => {
  const holds = [{ ownerUserId: 'u', startedAt: Date.parse('2026-11-01T12:00:00Z') }];
  const thread = (at, owner = 'u') => ({ messages: [{ owner_user_id: owner, observedAt: at }] });
  assert.equal(heldForOwnBackfill(thread('2026-11-01T09:00:00Z'), holds), true);
  assert.equal(heldForOwnBackfill(thread('2026-11-01T13:00:00Z'), holds), false);
  assert.equal(heldForOwnBackfill(thread('2026-11-01T09:00:00Z', 'teammate'), holds), false);
  assert.equal(heldForOwnBackfill(thread('2026-11-01T09:00:00Z'), []), false);
});

test("a conversation read on the person's plan goes in the ledger unbilled", () => {
  const bill = { kind: 'meeting', credits: 3 };
  assert.equal(readValue({ ref: 'r', valid_from: 't', meta: { own_model: true } }, bill).own_model, true);
  assert.equal('own_model' in readValue({ ref: 'r', valid_from: 't', meta: {} }, bill), false);
});

test('inside a run the credit gate does not ask: nothing of ours is spent', async () => {
  const fetched = globalThis.fetch;
  process.env.WORKER_INTERNAL_SECRET = 's'; process.env.API_INTERNAL_URL = 'http://nothing.example';
  globalThis.fetch = () => { throw new Error('asked the api'); };
  try {
    assert.equal(await withOwnModel(async () => ({}), () => mayReadWorkspace('own-run-ws')).then(g => g.allowed), true);
  } finally { globalThis.fetch = fetched; }
});

test("a teammate's thread is not this person's to read", () => {
  assert.equal(threadIsTheirs({ messages: [{ owner_user_id: 'teammate' }, { owner_user_id: 'u' }] }, 'u'), true);
  assert.equal(threadIsTheirs({ messages: [{ owner_user_id: 'teammate' }, { owner_user_id: null }] }, 'u'), false);
});

test("a job that is not an own-plan backfill is refused", async () => {
  const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { job_id: 'j', state: {} } }) };
  await assert.rejects(runOwnBackfill({ from: () => b }, 'j', { enrich: async () => {}, readEmail: async () => {} }), /not an own-plan/);
});
