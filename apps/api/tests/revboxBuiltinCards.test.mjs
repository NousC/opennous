// GET-897: built-in jobs as RevBox agent cards (their sentence, Starts, tools, On/Off from the
// workspace's real switches, recent activity), the default boxes ensured for Workspace-plan
// workspaces on the RevBox list, and the built-in behind a Priorities draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinJobsOut, ensureBuiltinBoxesForPlan, builtinStateOf } from '../src/routes/api/revboxes.mjs';
import { originOf } from '../src/lib/actionOrigin.mjs';

test('a built-in card: its brief from the workspace facts, its real On/Off, what it did lately', () => {
  const facts = { recorders: ['fireflies'], crm: null, followUpsOn: true, detectorsOn: false };
  const [fu, stale] = builtinJobsOut(['stale_deal', 'sales_follow_up'], [{ key: 'sales_follow_up', drafts: 12, last_at: '2026-10-15T09:00:00Z' }], facts);
  assert.equal(fu.key, 'sales_follow_up');
  assert.match(fu.brief.text, /^When a Fireflies meeting with a customer ends, I draft the follow-up email/);
  assert.equal(fu.brief.starts, 'After each meeting');
  assert.deepEqual(fu.brief.tools, ['fireflies']);
  assert.equal(fu.enabled, true);
  assert.equal(fu.drafts_30d, 12);
  assert.equal(stale.enabled, false, 'the detectors are off until the workspace is allowlisted');
  assert.equal(stale.brief.starts, 'Nightly');
  // Without facts (an older caller) the state is unknown, never claimed.
  assert.equal(builtinJobsOut(['expansion'], [])[0].enabled, null);
});

test('On/Off comes from the switch that really runs each built-in', () => {
  assert.equal(builtinStateOf('sales_follow_up', { followUpsOn: false, detectorsOn: true }), false);
  assert.equal(builtinStateOf('deal_signals', { followUpsOn: false, detectorsOn: true }), true);
  assert.equal(builtinStateOf('deal_signals', {}), null);
});

test('the default boxes are ensured only on the Workspace plan, and once a pass has nothing left to do it rests', async () => {
  const calls = [];
  const ensure = async (sb, ws) => { calls.push(ws); return { planned: [], created: [], added: [] }; };
  assert.equal(await ensureBuiltinBoxesForPlan({}, 'ws-api', { planId: 'api', ensure }), null);
  assert.deepEqual(calls, []);
  const done = await ensureBuiltinBoxesForPlan({}, 'ws-custom', { planId: 'custom', ensure, now: 1_000 });
  assert.deepEqual(done, { planned: [], created: [], added: [] });
  assert.equal(await ensureBuiltinBoxesForPlan({}, 'ws-custom', { planId: 'custom', ensure, now: 2_000 }), null, 'rests for a while');
  await ensureBuiltinBoxesForPlan({}, 'ws-custom', { planId: 'custom', ensure, now: 1_000 + 11 * 60_000 });
  assert.deepEqual(calls, ['ws-custom', 'ws-custom']);
  // Legacy Workspace ids count as the Workspace plan.
  await ensureBuiltinBoxesForPlan({}, 'ws-legacy', { planId: 'enterprise', ensure });
  assert.deepEqual(calls.at(-1), 'ws-legacy');
  // A failing ensure never breaks the list.
  assert.equal(await ensureBuiltinBoxesForPlan({}, 'ws-x', { planId: 'custom', ensure: async () => { throw new Error('db down'); } }), null);
});

test('a detector draft names the built-in behind it, for the Priorities chip', () => {
  const recs = new Map([['r1', { id: 'r1', rec_key: 'automation.deal_signal', evidence: { why: 'Raised an objection' } }], ['r2', { id: 'r2', rec_key: 'automation.expansion_signal' }], ['r3', { id: 'r3', rec_key: 'reach_out' }]]);
  assert.equal(originOf({ id: 'a', rec_id: 'r1' }, { recs }).builtin, 'deal_signals');
  assert.equal(originOf({ id: 'a', rec_id: 'r2' }, { recs }).builtin, 'expansion');
  assert.equal(originOf({ id: 'a', rec_id: 'r3' }, { recs }).builtin, null);
});
