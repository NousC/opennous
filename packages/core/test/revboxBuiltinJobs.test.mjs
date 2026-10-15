// GET-897: built-in jobs read as RevBox jobs. Each has a server-built sentence in the agent's voice
// (builtinJobBrief), every Workspace-plan workspace has them in default boxes (planDefaultBuiltinBoxes,
// ensureDefaultBuiltinBoxes), and a box's built-ins change by operations on the server's row, so a
// page holding an older copy can never drop one (the "Meetings Follow-up lost its built-in" bug).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  builtinJobBrief, planDefaultBuiltinBoxes, ensureDefaultBuiltinBoxes, applyBuiltinOps, patchRevbox, validateRevboxPatch,
  workspaceDefaultOwner, DEFAULT_BUILTIN_BOXES, REVBOX_BUILTIN_KEYS,
} from '../src/db/revboxes.mjs';

// ── The sentence ────────────────────────────────────────────────────────────────

test('the after-call follow-up names the connected recorders and what it really does', () => {
  const none = builtinJobBrief('sales_follow_up', {});
  assert.equal(none.text, 'When a meeting with a customer ends, I draft the follow-up email and propose the tasks and the CRM updates from what was said; you approve each one in Priorities.');
  assert.equal(none.starts, 'After each meeting');
  assert.deepEqual(none.tools, []);
  assert.equal(none.lands, 'Priorities');
  const ff = builtinJobBrief('sales_follow_up', { recorders: ['fireflies'] });
  assert.match(ff.text, /^When a Fireflies meeting with a customer ends, I draft the follow-up email/);
  assert.deepEqual(ff.tools, ['fireflies']);
  const two = builtinJobBrief('sales_follow_up', { recorders: ['fathom', 'granola', 'slack'], crm: 'hubspot' });
  assert.equal(two.text, 'When a Granola or Fathom meeting with a customer ends, I draft the follow-up email and propose the tasks and the HubSpot updates from what was said; you approve each one in Priorities, and approved ones sync to HubSpot.');
  assert.deepEqual(two.tools, ['granola', 'fathom', 'hubspot']);
  assert.ok(two.details.length >= 2);
});

test('every built-in has a sentence, a Starts label and lands in Priorities; nothing claims it sends on its own', () => {
  for (const key of REVBOX_BUILTIN_KEYS) {
    const b = builtinJobBrief(key, { recorders: ['granola'] });
    assert.ok(b && b.text.startsWith(key === 'sales_follow_up' ? 'When' : 'Every'), key);
    assert.match(b.text, /you approve each one in Priorities\.$/, key);
    assert.ok(b.starts, key);
    assert.doesNotMatch(b.text, /\bI send\b|\bsends\b/, key);
  }
  assert.equal(builtinJobBrief('deal_signals').starts, 'Hourly');
  assert.equal(builtinJobBrief('nope'), null);
});

// ── Default boxes ───────────────────────────────────────────────────────────────

const box = (id, name, builtin_jobs = [], created_at = '2026-10-01T00:00:00Z', revision = 1) => ({ id, name, builtin_jobs, created_at, revision });

test('a Workspace-plan workspace with no boxes gets the three default boxes', () => {
  assert.deepEqual(planDefaultBuiltinBoxes([]).map(s => [s.create, s.keys]), [
    ['Meetings Follow-up', ['sales_follow_up']],
    ['Pipeline Health', ['stale_deal', 'deal_risk', 'deal_signals']],
    ['Customer Growth', ['expansion']],
  ]);
  assert.deepEqual(DEFAULT_BUILTIN_BOXES.flatMap(b => b.keys).sort(), [...REVBOX_BUILTIN_KEYS].sort(), 'every built-in has a default box');
});

test('a box with the default name gains the built-in; one already in another box is never moved', () => {
  const plan = planDefaultBuiltinBoxes([
    box('m2', 'meetings follow-up ', [], '2026-10-03T00:00:00Z'), box('m1', 'Meetings Follow-up', [], '2026-10-02T00:00:00Z'),
    box('mine', 'My deals', ['stale_deal']),
  ]);
  assert.deepEqual(plan, [
    { add: 'm1', name: 'Meetings Follow-up', revision: 1, keys: ['sales_follow_up'] },
    { create: 'Pipeline Health', objective: DEFAULT_BUILTIN_BOXES[1].objective, keys: ['deal_risk', 'deal_signals'] },
    { create: 'Customer Growth', objective: DEFAULT_BUILTIN_BOXES[2].objective, keys: ['expansion'] },
  ]);
  assert.deepEqual(planDefaultBuiltinBoxes([box('a', 'Anything', [...REVBOX_BUILTIN_KEYS])]), [], 'all placed: nothing to do');
});

function database(tables) {
  let seq = 0;
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select() { return this; } order() { return this; } limit() { return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    in(k, vs) { this.filters.push(r => vs.includes(r[k])); return this; }
    update(v) { this.op = ['update', v]; return this; }
    insert(v) { this.op = ['insert', v]; return this; }
    delete() { this.op = ['delete']; return this; }
    run(single) {
      const t = tables[this.table] ??= [];
      if (this.op?.[0] === 'insert') { const row = { id: `new-${++seq}`, revision: 1, created_at: `2026-10-15T00:00:${String(seq).padStart(2, '0')}Z`, builtin_jobs: [], ...structuredClone(this.op[1]) }; t.push(row); return { data: structuredClone(row), error: null }; }
      const hit = t.filter(r => this.filters.every(f => f(r)));
      if (this.op?.[0] === 'update') for (const r of hit) Object.assign(r, structuredClone(this.op[1]));
      if (this.op?.[0] === 'delete') tables[this.table] = t.filter(r => !hit.includes(r));
      return { data: structuredClone(single ? hit[0] ?? null : hit), error: null };
    }
    maybeSingle() { return Promise.resolve(this.run(true)); } single() { return this.maybeSingle(); }
    then(ok, ko) { return Promise.resolve(this.run(false)).then(ok, ko); }
  }
  return { tables, from: t => new Query(t) };
}

test('ensuring the default boxes is idempotent, shared, owned by the workspace owner', async () => {
  const sb = database({
    workspace_members: [
      { workspace_id: 'ws', user_id: 'support', role: 'owner', created_at: '2026-01-01', support_until: '2026-12-01' },
      { workspace_id: 'ws', user_id: 'admin', role: 'admin', created_at: '2026-01-02' },
      { workspace_id: 'ws', user_id: 'boss', role: 'owner', created_at: '2026-01-03' },
    ],
    revboxes: [{ ...box('m', 'Meetings Follow-up', []), workspace_id: 'ws', owner_id: 'admin', shared: true }],
  });
  assert.equal(await workspaceDefaultOwner(sb, 'ws'), 'boss');
  const dry = await ensureDefaultBuiltinBoxes(sb, 'ws', { dryRun: true });
  assert.equal(dry.planned.length, 3); assert.equal(sb.tables.revboxes.length, 1, 'a dry run writes nothing');
  const first = await ensureDefaultBuiltinBoxes(sb, 'ws');
  assert.deepEqual(first.added, ['m']); assert.equal(first.created.length, 2);
  const m = sb.tables.revboxes.find(b => b.id === 'm');
  assert.deepEqual(m.builtin_jobs, ['sales_follow_up']); assert.equal(m.revision, 2);
  for (const b of sb.tables.revboxes.filter(b => b.id !== 'm')) { assert.equal(b.owner_id, 'boss'); assert.equal(b.shared, true); }
  const again = await ensureDefaultBuiltinBoxes(sb, 'ws');
  assert.deepEqual(again, { planned: [], created: [], added: [] });
  assert.equal(sb.tables.revboxes.length, 3, 'never duplicates');
});

test('two ensures at once: the box made first is kept, the later one removed', async () => {
  const sb = database({ workspace_members: [{ workspace_id: 'ws', user_id: 'boss', role: 'owner' }], revboxes: [
    // A racing call already made this one a moment ago.
    { ...box('early', 'Customer Growth', ['expansion'], '2026-10-14T00:00:00Z'), workspace_id: 'ws' },
  ] });
  // This call planned before it saw the early box.
  const plan = { create: 'Customer Growth', objective: '', keys: ['expansion'] };
  const real = sb.from;
  let first = true;
  sb.from = (t) => { const q = real(t); if (t === 'revboxes' && first) { first = false; q.run = () => ({ data: [], error: null }); } return q; };
  const out = await ensureDefaultBuiltinBoxes(sb, 'ws', { ownerId: 'boss' });
  assert.ok(out.planned.some(s => s.create === plan.create));
  assert.equal(sb.tables.revboxes.filter(b => b.name === 'Customer Growth').length, 1);
  assert.equal(sb.tables.revboxes.find(b => b.name === 'Customer Growth').id, 'early');
});

// ── The bug: a built-in falling out of its box ─────────────────────────────────

test('built-in changes apply to the server row: a page with an older copy cannot drop one', async () => {
  assert.deepEqual(applyBuiltinOps(['sales_follow_up'], { add: ['stale_deal'] }), ['sales_follow_up', 'stale_deal']);
  assert.deepEqual(applyBuiltinOps(['sales_follow_up', 'stale_deal'], { remove: ['stale_deal', 'expansion'] }), ['sales_follow_up']);
  assert.match(validateRevboxPatch({ revision: 1, builtin_add: ['nope'] }), /built-in/);
  assert.match(validateRevboxPatch({ revision: 1, builtin_jobs: [], builtin_add: ['stale_deal'] }), /not both/);

  const sb = database({
    workspace_members: [{ workspace_id: 'ws', user_id: 'owner', role: 'owner' }],
    revbox_members: [],
    revboxes: [{ ...box('rep', 'Rep Follow-up', ['sales_follow_up']), workspace_id: 'ws', owner_id: 'owner', shared: true, scope: {}, blocks: [], delivery: [] }],
  });
  // The rename autosave (the full editor body, no built-ins) keeps the built-in.
  const renamed = await patchRevbox(sb, 'ws', 'owner', 'rep', { revision: 1, name: 'Meetings Follow-up', objective: '', scope: { mode: 'all', account_ids: [], min_icp: 0 }, blocks: [], delivery: [] });
  assert.deepEqual(renamed.builtin_jobs, ['sales_follow_up']);
  // A page whose copy of the built-ins is older than the box (it shows none) adds one: the
  // built-in already there stays. Before GET-897 the page sent its whole list ([..., 'expansion'])
  // and the server stored it as sent, so 'sales_follow_up' fell out.
  const added = await patchRevbox(sb, 'ws', 'owner', 'rep', { revision: 2, builtin_add: ['expansion'] });
  assert.deepEqual(added.builtin_jobs, ['sales_follow_up', 'expansion']);
  const removed = await patchRevbox(sb, 'ws', 'owner', 'rep', { revision: 3, builtin_remove: ['expansion'] });
  assert.deepEqual(removed.builtin_jobs, ['sales_follow_up']);
});
