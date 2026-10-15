// GET-878: a workspace with an ICP file marked in Settings > Context is scored by Nous from it.
// Marking a file ICP (or rebuilding from it) on a workspace whose scorer is 'external' needs an
// explicit confirmation; without it the API answers 409 and writes nothing. With it the file is
// marked, the workspace switches to 'nous', and the scorecard is built from the file (force).
// A workspace already on 'nous' behaves as before; an open-source build never switches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { markIcpFile, ICP_SCORER_SWITCH_CODE, ICP_SCORER_SWITCH_MESSAGE } from '../src/lib/icpContextFile.mjs';

const WS = '00000000-0000-0000-0000-000000000001';

function harness(initial) {
  const state = { scorer: initial, seeds: [], sets: [], writes: 0, mirrors: 0 };
  const model = { seedScorecardFromMemory: async (_sb, _ws, { force }) => {
    if (state.scorer === 'external') return { status: 'external_scorer', signals: [] };
    state.seeds.push({ force }); return { status: 'created', signals: new Array(20).fill({}) };
  } };
  const deps = {
    model,
    scorer: async () => state.scorer,
    setScorer: async (_sb, _ws, s) => { state.sets.push(s); state.scorer = s; },
    mirror: async () => { state.mirrors++; return { status: 'mirrored' }; },
  };
  const write = async () => { state.writes++; return { id: 'file-1', kind: 'icp' }; };
  return { state, deps, write };
}

test('marking an ICP file on an external workspace without confirmation is a 409 and writes nothing', async () => {
  const { state, deps, write } = harness('external');
  await assert.rejects(markIcpFile({}, WS, {}, write, deps), e => {
    assert.equal(e.status, 409);
    assert.equal(e.reply.code, ICP_SCORER_SWITCH_CODE);
    assert.equal(e.message, ICP_SCORER_SWITCH_MESSAGE);
    assert.match(e.message, /Nous will score this workspace's accounts from this file from now on/);
    return true;
  });
  assert.equal(state.writes, 0);
  assert.equal(state.mirrors, 0);
  assert.deepEqual(state.sets, []);
  assert.deepEqual(state.seeds, []);
  assert.equal(state.scorer, 'external');
});

test('with confirmation: the file is marked, the scorer becomes nous, and the scorecard is rebuilt from it (force)', async () => {
  const { state, deps, write } = harness('external');
  const out = await markIcpFile({}, WS, { confirm: true }, write, deps);
  assert.equal(state.writes, 1);
  assert.deepEqual(state.sets, ['nous']);
  assert.equal(state.scorer, 'nous');
  assert.deepEqual(state.seeds, [{ force: true }]);
  assert.equal(out.result.id, 'file-1');
  assert.equal(out.icp.status, 'created');
  assert.equal(out.icp.signals, 20);
  assert.equal(out.icp.foundation, 'mirrored');
  assert.equal(out.icp.scorer_switched, true);
});

test('rebuild on an external workspace never silently answers external_scorer: confirm, switch, rebuild', async () => {
  const { state, deps } = harness('external');
  const noWrite = async () => null;
  await assert.rejects(markIcpFile({}, WS, { rebuild: true }, noWrite, deps), e => e.status === 409 && e.reply.code === ICP_SCORER_SWITCH_CODE);
  assert.deepEqual(state.seeds, []); assert.equal(state.mirrors, 0);
  const out = await markIcpFile({}, WS, { rebuild: true, confirm: true }, noWrite, deps);
  assert.notEqual(out.icp.status, 'external_scorer');
  assert.equal(out.icp.status, 'created');
  assert.deepEqual(state.sets, ['nous']);
  assert.deepEqual(state.seeds, [{ force: true }]);
});

test('a workspace already on nous: no confirmation, no switch, first scorecard only (force false); rebuild forces', async () => {
  const { state, deps, write } = harness('nous');
  const out = await markIcpFile({}, WS, {}, write, deps);
  assert.equal(state.writes, 1);
  assert.deepEqual(state.sets, []);
  assert.deepEqual(state.seeds, [{ force: false }]);
  assert.equal(out.icp.scorer_switched, undefined);
  await markIcpFile({}, WS, { rebuild: true }, async () => null, deps);
  assert.deepEqual(state.seeds, [{ force: false }, { force: true }]);
  assert.deepEqual(state.sets, []);
});

test('an open-source build (no learned scorer) never switches and answers not_available with a message', async () => {
  const { state, deps, write } = harness('external');
  const out = await markIcpFile({}, WS, {}, write, { ...deps, model: null });
  assert.equal(state.writes, 1);
  assert.deepEqual(state.sets, []);
  assert.equal(state.scorer, 'external');
  assert.equal(out.icp.status, 'not_available');
  assert.match(out.icp.message, /Nous Cloud/);
  const confirmed = await markIcpFile({}, WS, { confirm: true, rebuild: true }, async () => null, { ...deps, model: null });
  assert.equal(confirmed.icp.status, 'not_available');
  assert.deepEqual(state.sets, []);
});

test('a non-admin is not asked to confirm: the write refuses them (403) and nothing switches', async () => {
  const { state, deps } = harness('external');
  const refuse = async () => { throw Object.assign(new Error('Only a workspace owner or admin can choose the ICP file.'), { status: 403 }); };
  await assert.rejects(markIcpFile({}, WS, { admin: false }, refuse, deps), e => e.status === 403);
  assert.deepEqual(state.sets, []); assert.deepEqual(state.seeds, []); assert.equal(state.mirrors, 0);
});

test('unmarking does not switch the scorer back', async () => {
  const { state, deps, write } = harness('external');
  await markIcpFile({}, WS, { confirm: true }, write, deps);
  assert.equal(state.scorer, 'nous');
  // The route's unmark path (PATCH kind 'reference') does not call markIcpFile; the scorer stays.
  const { icpMarking } = await import('../src/routes/api/revboxes.mjs');
  assert.equal(icpMarking({ kind: 'reference' }, { kind: 'icp' }), false);
  assert.equal(icpMarking({ kind: 'icp' }, { kind: 'reference' }), true);
  assert.equal(icpMarking({ title: 'x' }, { kind: 'icp' }), false);
  assert.equal(state.scorer, 'nous');
});
