// The api's half of Free's hard stop (GET-700): a hard cap is counted fresh, not from the ten-
// minute cache, and the answer says how many credits are left before reading stops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTeamAiCredits } from '../src/lib/plans.mjs';
import { HAS_CLOUD } from '../src/lib/cloud.mjs';

// Credits are metered on Cloud. An open-source build is self-hosted (GET-754): the operator's own
// box and keys, so no cap stops it and the count is only reported.
function assertSelfHostUncapped(r, used) {
  assert.equal(r.used, used);
  assert.equal(r.hardCap, false);
  assert.equal(r.untilStop, null);
  assert.equal(r.unlimited, true);
  assert.equal(r.state, 'ok');
}

// Every table answers from `tables`, whatever the filters: one workspace, so filters do not matter.
function fakeSupabase(tables) {
  return {
    from(name) {
      const q = {
        select() { return q; }, eq() { return q; }, in() { return q; }, not() { return q; },
        gte() { return q; }, lt() { return q; }, order() { return q; },
        range(a) { return Promise.resolve({ data: a === 0 ? (tables[name] ?? []) : [], error: tables.__error ?? null }); },
        then(resolve) { return Promise.resolve({ data: tables[name] ?? [], error: null }).then(resolve); },
      };
      return q;
    },
  };
}
const reads = (n) => Array.from({ length: n }, (_, i) => ({ source: 'gmail', observed_at: new Date(Date.now() - i * 1000).toISOString(), value: {} }));
const free = { plan_id: 'free', status: 'active' };

test('a hard cap is counted fresh on every call, and says what is left before the stop', async () => {
  const tables = { workspaces: [{ id: 'ws-hard-1' }], observations: reads(100), llm_usage: [] };
  const sb = fakeSupabase(tables);
  const a = await getTeamAiCredits(sb, 'team-hard-1', free);
  if (!HAS_CLOUD) return assertSelfHostUncapped(a, 200);
  assert.equal(a.used, 200);
  assert.equal(a.hardCap, true);
  assert.equal(a.untilStop, 300);
  tables.observations = reads(249);
  const b = await getTeamAiCredits(sb, 'team-hard-1', free);
  assert.equal(b.used, 498, 'not the cached 200');
  assert.equal(b.untilStop, 2);
  assert.notEqual(b.state, 'restricted');
  tables.observations = reads(250);
  const c = await getTeamAiCredits(sb, 'team-hard-1', free);
  assert.equal(c.untilStop, 0);
  assert.equal(c.state, 'restricted');
});

test('a band plan stops at 120%, so that is where untilStop runs to', async () => {
  const sb = fakeSupabase({ workspaces: [{ id: 'ws-band-1' }], observations: reads(100), llm_usage: [] });
  const r = await getTeamAiCredits(sb, 'team-band-1', { plan_id: 'api', status: 'active', stripe_subscription_id: 'sub_x' });
  if (!HAS_CLOUD) return assertSelfHostUncapped(r, 200);
  assert.equal(r.hardCap, false);
  assert.equal(r.included, 960);
  assert.equal(r.untilStop, Math.ceil(960 * 1.2) - 200);
});

test('a failed count is flagged, so the worker does not read it as a fresh allowance', async () => {
  const sb = fakeSupabase({ workspaces: [{ id: 'ws-hard-2' }], observations: reads(10), __error: { message: 'boom' } });
  const r = await getTeamAiCredits(sb, 'team-hard-2', free);
  assert.equal(r.meterError, true);
  assert.equal(r.used, 0);
});
