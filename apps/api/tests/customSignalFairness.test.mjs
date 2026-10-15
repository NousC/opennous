// Custom signal extraction shares its per-tick budget fairly (GET-892): one busy workspace no
// longer starves the rest. Driven with injected reads and writes: no database, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCustomSignals, CUSTOM_SIGNAL_TICK_BUDGET, CUSTOM_SIGNAL_WORKSPACE_BUDGET } from '../src/lib/revboxRuntime.mjs';

/** Definitions per workspace, each with `claims` readable claims; records what was classified. */
function world(spec, { gateFails = [] } = {}) {
  const defs = [];
  for (const [ws, perDef] of Object.entries(spec)) {
    perDef.forEach((count, i) => defs.push({ id: `${ws}-d${i}`, workspace_id: ws, owner_id: 'u', revbox_id: null, claims: Array.from({ length: count }, (_, n) => ({ id: `${ws}-d${i}-c${n}`, entity_id: `e${n}` })) }));
  }
  const log = { classified: [], advanced: [], gates: [] };
  const io = {
    activeCustomSignals: async () => defs,
    revboxMembership: async () => {},
    customSignalCandidates: async (_sb, d) => ({ candidates: d.claims, readable: d.claims }),
    customSignalAccount: async () => 'acct',
    gate: async (_sb, ws) => { log.gates.push(ws); if (gateFails.includes(ws)) throw Object.assign(new Error('Credits are required.'), { status: 402 }); },
    claimCustomExtraction: async (_sb, d, claim) => ({ id: `x-${claim.id}` }),
    classify: async (d, claim) => { log.classified.push({ ws: d.workspace_id, def: d.id, claim: claim.id }); return null; },
    customSignalIsCurrent: async () => true,
    publishCustomSignal: async () => {},
    finishCustomExtraction: async () => {},
    advanceCustomSignal: async (_sb, d) => { log.advanced.push(d.id); },
    log: () => {},
  };
  return { io, log };
}
const count = (list, key) => list.reduce((m, x) => ({ ...m, [x[key]]: (m[x[key]] ?? 0) + 1 }), {});

test('the budgets are named constants', () => {
  assert.equal(CUSTOM_SIGNAL_WORKSPACE_BUDGET, 10);
  assert.equal(CUSTOM_SIGNAL_TICK_BUDGET, 50);
});

test('one busy workspace does not starve the others', async () => {
  // Busy has 3 definitions with 100 claims each; two quiet workspaces have a few each.
  const { io, log } = world({ busy: [100, 100, 100], quiet1: [3], quiet2: [2, 2] });
  await extractCustomSignals({}, io);
  const byWs = count(log.classified, 'ws');
  assert.equal(byWs.quiet1, 3);
  assert.equal(byWs.quiet2, 4);
  assert.equal(byWs.busy, CUSTOM_SIGNAL_WORKSPACE_BUDGET);
  // Within the busy workspace the budget is shared across its definitions too.
  const busyDefs = count(log.classified.filter(c => c.ws === 'busy'), 'def');
  assert.deepEqual(Object.values(busyDefs).sort(), [3, 3, 4]);
  // Only definitions whose claims were all read move their cursor on.
  assert.deepEqual(log.advanced.sort(), ['quiet1-d0', 'quiet2-d0', 'quiet2-d1']);
});

test('the tick budget caps the total and is spread across workspaces', async () => {
  const spec = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`ws${i}`, [40]]));
  const { io, log } = world(spec);
  await extractCustomSignals({}, io);
  assert.equal(log.classified.length, CUSTOM_SIGNAL_TICK_BUDGET);
  const byWs = Object.values(count(log.classified, 'ws'));
  assert.equal(byWs.length, 8, 'every workspace got a turn');
  assert.ok(Math.max(...byWs) - Math.min(...byWs) <= 1, `even shares, got ${byWs}`);
});

test('the start rotates between ticks so the tail workspaces are not always last', async () => {
  const spec = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`ws${String(i).padStart(2, '0')}`, [5]]));
  const first = world(spec), second = world(spec);
  await extractCustomSignals({}, { ...first.io, rotation: 0 });
  await extractCustomSignals({}, { ...second.io, rotation: 1 });
  assert.equal(first.log.classified[0].ws, 'ws00');
  assert.notEqual(second.log.classified[0].ws, 'ws00');
});

test('the credit gate is per workspace: one out of credits does not stop the others', async () => {
  const { io, log } = world({ broke: [5], paid: [5] }, { gateFails: ['broke'] });
  await extractCustomSignals({}, io);
  assert.deepEqual(count(log.classified, 'ws'), { paid: 5 });
  // Checked once for the broke workspace this tick, not once per claim.
  assert.equal(log.gates.filter(w => w === 'broke').length, 1);
  assert.ok(!log.advanced.includes('broke-d0'), 'its cursor stays so the claims are read later');
});
