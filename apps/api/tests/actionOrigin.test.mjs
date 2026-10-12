// Where a waiting draft came from (GET-681): the Priorities inbox names the automation, play or
// conversation behind each pending_actions row, read back from the trails those paths already
// write — no source column. These pin the precedence and the joins.
//
// Run: node --test apps/api/tests/actionOrigin.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originOf, accountOf, draftedIds, withOrigins } from '../src/lib/actionOrigin.mjs';

const AT = '2026-10-04T12:05:00.000Z';
const act = (id, extra = {}) => ({ id, workspace_id: 'w1', kind: 'email', entity_id: 'p1', thread_id: null, rec_id: null, created_at: AT, ...extra });

test('a play draft is named for its play', () => {
  const o = originOf(act('a1'), { plays: new Map([['a1', { run_id: 'r1', play_key: 'deal-rescue' }]]) });
  assert.equal(o.source, 'play');
  assert.equal(o.name, 'Deal rescue');
  assert.equal(o.run_id, 'r1');
  assert.equal(o.at, AT);
});

test('a routine draft is named for the automation, with its run', () => {
  const o = originOf(act('a1'), { routines: new Map([['a1', { name: 'Deal risk detection', trigger_kind: 'clock', run_id: 'run1', routine_id: 'rt1', thread_id: 't9' }]]) });
  assert.deepEqual([o.source, o.name, o.run_id, o.routine_id, o.why], ['routine', 'Deal risk detection', 'run1', 'rt1', null]);
  const before = originOf(act('a1'), { routines: new Map([['a1', { name: 'Call prep', trigger_kind: 'before_meeting' }]]) });
  assert.equal(before.why, 'Before your meeting');
});

test('a draft from a recommendation is named for the detector and carries its reason', () => {
  const recs = new Map([['11111111-1111-1111-1111-111111111111', { id: '11111111-1111-1111-1111-111111111111', rec_key: 'follow_up_quiet', evidence: { why: 'No conversation in 16 days.' } }]]);
  const o = originOf(act('a1', { rec_id: '11111111-1111-1111-1111-111111111111' }), { recs });
  assert.equal(o.name, 'Stale deal detection');
  assert.equal(o.why, 'No conversation in 16 days.');
});

test('a draft on a thread no routine owns came from Ask Nous; the plugin is "Your agent"', () => {
  assert.equal(originOf(act('a1', { thread_id: 't1' })).name, 'Ask Nous');
  assert.equal(originOf(act('a1', { thread_id: 't1' }), { routineThreads: new Set(['t1']) }).source, 'app');
  assert.equal(originOf(act('a2'), { decisions: new Map([['a2', { surface: 'agent' }]]) }).name, 'Your agent');
  assert.equal(originOf(act('a3')).source, 'app');
});

test('precedence: play, then routine, then recommendation', () => {
  const trails = {
    plays: new Map([['a1', { play_key: 'nurture' }]]),
    routines: new Map([['a1', { name: 'X' }], ['a2', { name: 'Y' }]]),
  };
  assert.equal(originOf(act('a1'), trails).name, 'Nurture');
  assert.equal(originOf(act('a2'), trails).name, 'Y');
});

test('the account behind a person is the company; a person with none keeps their name', () => {
  const labels = {
    companies: new Map([['c1', { id: 'c1', name: 'Cobalt', domain: 'cobalt.example' }]]),
    contacts: new Map([['p1', { id: 'p1', first_name: 'Marcus', last_name: 'Bell', company_id: 'c1' }], ['p2', { id: 'p2', first_name: 'Ana', last_name: null, company_id: null, domain: 'x.com' }]]),
  };
  assert.deepEqual(accountOf('p1', labels), { id: 'c1', name: 'Cobalt', domain: 'cobalt.example', person: 'Marcus Bell' });
  assert.deepEqual(accountOf('c1', labels), { id: 'c1', name: 'Cobalt', domain: 'cobalt.example', person: null });
  assert.deepEqual(accountOf('p2', labels), { id: null, name: null, domain: 'x.com', person: 'Ana' });
  assert.equal(accountOf(null, labels), null);
});

test('drafted ids come from the stored tool calls', () => {
  assert.deepEqual(draftedIds([{ name: 'get_account', output: {} }, { name: 'propose_email', output: { action_id: 'a1' } }, null]), ['a1']);
  assert.deepEqual(draftedIds(null), []);
});

/** Table rows, filtered by eq / in (incl. a ->> json path) the way the lookups ask. */
function fakeSupabase(tables) {
  return {
    from(table) {
      const filters = [];
      const val = (r, k) => (k.includes('->>') ? r[k.split('->>')[0]]?.[k.split('->>')[1]] : r[k]);
      const q = {
        select() { return q; },
        eq(k, v) { filters.push((r) => val(r, k) === v); return q; },
        in(k, vs) { filters.push((r) => vs.includes(val(r, k))); return q; },
        gte() { return q; }, not() { return q; }, limit() { return q; },
        then(res, rej) { return Promise.resolve({ data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))) }).then(res, rej); },
      };
      return q;
    },
  };
}

test('withOrigins joins every trail and keeps each action whole', async () => {
  const supabase = fakeSupabase({
    workflow_node_runs: [{ run_id: 'wr1', output: { action_id: 'a1' } }],
    workflow_runs: [{ id: 'wr1', play_key: 'deal-rescue' }],
    agent_routine_runs: [{ id: 'run1', routine_id: 'rt1', thread_id: 't9', workspace_id: 'w1' }],
    playground_messages: [{ thread_id: 't9', role: 'assistant', tool_calls: [{ name: 'propose_email', output: { action_id: 'a2' } }] }],
    agent_routines: [{ id: 'rt1', name: 'Deal risk detection', trigger_kind: 'clock' }],
    ri_decisions: [{ decision_id: 'app:a3', surface: 'agent', workspace_id: 'w1' }],
    companies: [{ id: 'c1', name: 'Cobalt', domain: 'cobalt.example' }],
    contacts: [{ id: 'p1', first_name: 'Marcus', last_name: 'Bell', company_id: 'c1' }],
  });
  const out = await withOrigins(supabase, 'w1', [act('a1'), act('a2'), act('a3'), act('a4', { thread_id: 't1' })]);
  assert.deepEqual(out.map((a) => a.origin.name), ['Deal rescue', 'Deal risk detection', 'Your agent', 'Ask Nous']);
  assert.equal(out[1].origin.run_id, 'run1');
  assert.equal(out[0].account.name, 'Cobalt');
  assert.equal(out[0].entity_id, 'p1');
  assert.deepEqual(await withOrigins(supabase, 'w1', []), []);
});

test('a trail that fails to load leaves the origin unknown, not the list empty', async () => {
  const broken = { from() { const q = { select: () => q, eq: () => q, in: () => q, gte: () => q, not: () => q, limit: () => q, then: (_res, rej) => Promise.reject(new Error('boom')).then(_res, rej) }; return q; } };
  const out = await withOrigins(broken, 'w1', [act('a1')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].origin.source, 'app');
  assert.equal(out[0].account, null);
});
