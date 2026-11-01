// A paid backfill reads what was bought (GET-1087): its window past the plan's 90 days and the
// watermark, and past the month's gate, which is what an ended trial would otherwise stop it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayReadWorkspace, holdPaidBackfill, releasePaidBackfill } from '../src/lib/creditGate.mjs';
import { resolveBackfillCutoffMs } from '../src/services/contactHistoryEnricher.mjs';
import { isSelfHosted } from '../src/lib/cloud.mjs';

const D = 86_400_000;
function fakeDb(ws, sub) {
  return { from(name) {
    const q = { select() { return q; }, eq() { return q; }, maybeSingle() { return Promise.resolve({ data: name === 'workspaces' ? ws : sub }); } };
    return q;
  } };
}

test('a held workspace reads whatever the month says', async () => {
  const realFetch = globalThis.fetch;
  const env = { s: process.env.WORKER_INTERNAL_SECRET, u: process.env.NOUS_API_INTERNAL_URL };
  process.env.WORKER_INTERNAL_SECRET = 'x'; process.env.NOUS_API_INTERNAL_URL = 'http://api.example';
  let asked = 0;
  globalThis.fetch = async () => { asked++; return { ok: true, json: async () => ({ allowed: false, reason: 'no_plan' }) }; };
  try {
    holdPaidBackfill('ws-paid');
    const held = await mayReadWorkspace('ws-paid', { fresh: true });
    assert.equal(held.allowed, true);
    assert.equal(held.untilStop, null);
    assert.equal(asked, 0, 'the api is not asked');
    releasePaidBackfill('ws-paid');
    await mayReadWorkspace('ws-paid', { fresh: true });
    assert.equal(asked, 1, 'released: the gate is asked again');
  } finally {
    globalThis.fetch = realFetch;
    process.env.WORKER_INTERNAL_SECRET = env.s ?? ''; if (env.s === undefined) delete process.env.WORKER_INTERNAL_SECRET;
    if (env.u === undefined) delete process.env.NOUS_API_INTERNAL_URL; else process.env.NOUS_API_INTERNAL_URL = env.u;
  }
});

test('the window bought is the window read', async (t) => {
  if (isSelfHosted()) return t.skip('no cutoff on self-host');
  const sb = fakeDb({ team_id: 't', history_backfilled_at: new Date(Date.now() - 2 * D).toISOString() }, { plan_id: 'api', status: 'trialing' });
  const paid = await resolveBackfillCutoffMs(sb, 'w', 365, null, { paidWindow: true });
  assert.ok(Math.abs(paid - (Date.now() - 365 * D)) < 5000);
  const plain = await resolveBackfillCutoffMs(sb, 'w', 365, null);
  assert.ok(plain > Date.now() - 3 * D, 'an ordinary job keeps the plan window and the watermark');
});

test('a calendar read reaches as far as the window: 180 days at least, a year for a year', async () => {
  const { calendarLookbackDays, SYNC_WINDOW_DAYS } = await import('../src/services/contactHistoryEnricher.mjs');
  const now = Date.parse('2026-11-01');
  const ago = (d) => now - d * 86_400_000;
  assert.equal(calendarLookbackDays(ago(365), { now }), 365, 'paid 365');
  assert.equal(calendarLookbackDays(ago(180), { now }), 180, 'paid 180');
  assert.equal(calendarLookbackDays(ago(730), { now }), 730, 'nous backfill --days 730');
  assert.equal(calendarLookbackDays(ago(30), { now }), 180, 'a short window keeps what it always read');
  assert.equal(calendarLookbackDays(null, { now }), 180);
  assert.equal(calendarLookbackDays(null, { now, syncOnly: true }), SYNC_WINDOW_DAYS);
});

test('nothing but a paid or own-plan run gets past the 90-day clamp', async () => {
  const sb = { from() { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { team_id: 't', plan_id: 'api', status: 'active', history_backfilled_at: null } }) }; return q; } };
  const days = (ms) => Math.round((Date.now() - ms) / 86_400_000);
  for (const d of [180, 365]) {
    assert.equal(days(await resolveBackfillCutoffMs(sb, 'w', d, null, { paidWindow: true })), d);
    assert.equal(days(await resolveBackfillCutoffMs(sb, 'w', d, 'member', { ownPlan: true })), d);
    assert.equal(days(await resolveBackfillCutoffMs(sb, 'w', d, null)), 90);
  }
});
