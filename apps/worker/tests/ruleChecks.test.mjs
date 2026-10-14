// Rules, checked in the background (GET-846): a broken rule opens one flag per account and one task
// per broken instance; a met rule resolves the flag and closes the task; a task the rep closed stays
// closed; a rule's own task never counts as the next step it asks for.
//
// Run: node --test apps/worker/tests/ruleChecks.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWorkspaceRules, ruleTaskProperty, loadRuleData } from '../src/workers/ruleChecks.mjs';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const at = (h) => new Date(NOW + h * 3_600_000).toISOString();
const RULE = { id: 'r1aaaaaa-0000-4000-8000-000000000000', user_id: 'u1', statement: 'Every meeting ends with a dated next step within 48 hours', kind: 'checked', check_type: 'next_step_after_meeting', params: { hours: 48 }, weight: 'high', status: 'active' };

/** Just enough of supabase-js for the job's own reads and writes on claims and flags. */
function fakeDb(tables) {
  const rows = (t) => (tables[t] ??= []);
  return {
    tables,
    from(table) {
      const filters = [];
      let patch = null;
      const q = {
        select: () => q, order: () => q, limit: () => q, range: () => q,
        eq: (c, v) => { filters.push((r) => (c.startsWith('value->>') ? r.value?.[c.slice(8)] : r[c]) === v); return q; },
        in: (c, vs) => { const set = new Set(vs); filters.push((r) => set.has(r[c])); return q; },
        gte: (c, v) => { filters.push((r) => String(r[c]) >= String(v)); return q; },
        lt: (c, v) => { filters.push((r) => String(r[c]) < String(v)); return q; },
        is: (c, v) => { filters.push((r) => (r[c] ?? null) === v); return q; },
        like: (c, v) => { const pre = v.replace(/%$/, ''); filters.push((r) => String(r[c] ?? '').startsWith(pre)); return q; },
        update: (p) => { patch = p; return q; },
        then: (ok, bad) => {
          const hit = rows(table).filter((r) => filters.every((f) => f(r)));
          if (patch) for (const r of hit) Object.assign(r, patch);
          return Promise.resolve({ data: hit, error: null }).then(ok, bad);
        },
      };
      return q;
    },
  };
}

function harness(tables, data) {
  const db = fakeDb(tables);
  const raised = [], cleared = [], recorded = [];
  const deps = {
    listRules: async () => [RULE],
    loadRuleData: async () => data,
    upsertFlag: async (_s, _w, p) => { raised.push(p); return { id: 'f' }; },
    resolveFlagIfOpen: async (_s, _w, entityId, flagType) => { cleared.push(`${entityId}|${flagType}`); },
    recordObservation: async (_s, o) => { recorded.push(o); db.tables.claims.push({ id: `c${recorded.length}`, entity_id: o.entityId, property: o.property, value: o.value, invalid_at: null, workspace_id: 'ws' }); return { id: 'o' }; },
  };
  return { db, raised, cleared, recorded, run: () => checkWorkspaceRules(db, 'ws', { now: NOW, deps }) };
}

const broken = {
  meetings: [
    { account_id: 'acc1', key: 'acc1:m1', at: at(-60), owner_user_id: 'u1', title: 'Pilot review' },
    { account_id: 'acc1', key: 'acc1:m2', at: at(-72), owner_user_id: 'u1', title: 'Kickoff' },
  ],
  tasks: [], bookings: [],
};

test('a broken rule raises one flag per account (worst first, high weight) and one task per meeting', async () => {
  const h = harness({ claims: [], flags: [] }, broken);
  const stats = await h.run();
  assert.equal(h.raised.length, 1);
  assert.equal(h.raised[0].flagType, `rule:${RULE.id}`);
  assert.equal(h.raised[0].ownerUserId, 'u1');
  assert.equal(h.raised[0].source, 'rule');
  assert.match(h.raised[0].reason, /Kickoff.*\(\+1 more\)/);
  assert.ok(h.raised[0].priority >= 30, 'a high rule sits in the top band');
  assert.equal(h.recorded.length, 2);
  assert.ok(h.recorded.every((o) => o.property.startsWith('action_item.rule_') && o.value.status === 'open' && o.value.owner_kind === 'user'));
  assert.deepEqual(stats.tasks_opened, 2);
  // Run again: the same tasks are not written twice.
  await h.run();
  assert.equal(h.recorded.length, 2);
});

test('once met, the flag resolves and the open task closes; a task the rep closed is left alone', async () => {
  const p1 = ruleTaskProperty(RULE.id, 'next_step_after_meeting:acc1:m1');
  const p2 = ruleTaskProperty(RULE.id, 'next_step_after_meeting:acc1:m2');
  const tables = {
    flags: [{ workspace_id: 'ws', entity_id: 'acc1', flag_type: `rule:${RULE.id}`, status: 'open' }],
    claims: [
      { id: 'c1', workspace_id: 'ws', entity_id: 'acc1', property: p1, value: { status: 'open', title: 'a', rule_id: RULE.id, rule_key: 'next_step_after_meeting:acc1:m1' }, invalid_at: null },
      { id: 'c2', workspace_id: 'ws', entity_id: 'acc1', property: p2, value: { status: 'done', completed_by: 'user', title: 'b' }, invalid_at: null },
    ],
  };
  // Met: a dated task said in the later meeting counts for both (it came after each of them).
  const h = harness(tables, { ...broken, tasks: [{ account_id: 'acc1', occurred_at: at(-60), due_at: at(24) }] });
  const stats = await h.run();
  assert.equal(h.raised.length, 0);
  assert.deepEqual(h.cleared, [`acc1|rule:${RULE.id}`]);
  assert.equal(tables.claims[0].value.status, 'done');
  assert.equal(tables.claims[0].value.completed_by, 'rule');
  assert.equal(tables.claims[0].value.completed_reason, 'your rule is met');
  assert.equal(tables.claims[1].value.completed_by, 'user', 'a hand close is not touched');
  assert.equal(stats.tasks_closed, 1);
});

test('a task the rep closed is not reopened while the rule is still broken', async () => {
  const p1 = ruleTaskProperty(RULE.id, 'next_step_after_meeting:acc1:m1');
  const tables = { flags: [], claims: [{ id: 'c1', workspace_id: 'ws', entity_id: 'acc1', property: p1, value: { status: 'done', completed_by: 'user' }, invalid_at: null }] };
  const h = harness(tables, { ...broken, meetings: [broken.meetings[0]] });
  await h.run();
  assert.equal(h.recorded.length, 0);
  assert.equal(tables.claims[0].value.status, 'done');
});

test('an instance that aged out closes as no longer checked, a removed rule as removed — never as met', async () => {
  const p1 = ruleTaskProperty(RULE.id, 'next_step_after_meeting:acc1:old');
  const pX = ruleTaskProperty('gone0000-0000-4000-8000-000000000000', 'next_step_after_meeting:acc1:m1');
  const tables = { flags: [], claims: [
    { id: 'c1', workspace_id: 'ws', entity_id: 'acc1', property: p1, value: { status: 'open', rule_id: RULE.id, rule_key: 'next_step_after_meeting:acc1:old' }, invalid_at: null },
    { id: 'c2', workspace_id: 'ws', entity_id: 'acc1', property: pX, value: { status: 'open', rule_id: 'gone0000-0000-4000-8000-000000000000', rule_key: 'k' }, invalid_at: null },
  ] };
  const h = harness(tables, { meetings: [], tasks: [], bookings: [] });
  await h.run();
  assert.equal(tables.claims[0].value.completed_reason, 'no longer checked: older than the rule looks back');
  assert.equal(tables.claims[1].value.completed_reason, 'your rule was paused or removed');
});

test('the loader drops teammates, names a meeting by account and hour, and dates a stage from its history', async () => {
  const STAGE_RULE = { ...RULE, id: 'r2', check_type: 'stage_without_meeting', params: { days: 21 } };
  const obs = (entity_id, property, observed_at, extra = {}) => ({ workspace_id: 'ws', kind: 'event', entity_id, property, observed_at, ...extra });
  const db = fakeDb({
    observations: [
      // One call: a buyer and a teammate, logged by the note-taker and by the calendar minutes apart.
      obs('p-buyer', 'interaction.meeting_held', at(-60), { owner_user_id: 'u1', value: { description: 'Meeting: Pilot review' } }),
      obs('p-mate', 'interaction.meeting_held', at(-60), { owner_user_id: 'u1', value: {} }),
      obs('p-buyer', 'interaction.meeting_held', new Date(Date.parse(at(-60)) + 10 * 60_000).toISOString(), { owner_user_id: 'u1', value: {} }),
      // Stage history: negotiation, then a nightly CRM re-observation of the same stage.
      { workspace_id: 'ws', entity_id: 'p-buyer', property: 'pipeline_stage', value: 'interested', observed_at: at(-24 * 50) },
      { workspace_id: 'ws', entity_id: 'p-buyer', property: 'pipeline_stage', value: 'negotiation', observed_at: at(-24 * 30) },
      { workspace_id: 'ws', entity_id: 'p-buyer', property: 'pipeline_stage', value: 'negotiation', observed_at: at(-2) },
    ],
    contacts: [{ id: 'p-buyer', company_id: 'acc1' }, { id: 'p-mate', company_id: 'us' }],
    companies: [{ id: 'acc1', name: 'Cobalt' }],
    claims: [{ workspace_id: 'ws', entity_id: 'p-buyer', property: 'pipeline_stage', value: 'negotiation', invalid_at: null }],
  });
  const data = await loadRuleData(db, 'ws', [RULE, STAGE_RULE], NOW, {
    getInternalEntityIds: async () => new Set(['p-mate']),
    owners: () => new Map([['p-buyer', { primary: 'u1' }]]),
  });
  assert.deepEqual([...new Set(data.meetings.map((m) => m.key))], [`acc1:${at(-60).slice(0, 13)}`]);
  assert.ok(data.meetings.every((m) => m.account_id === 'acc1'), 'the teammate row never becomes our own account');
  assert.equal(data.meetings[0].title, 'Pilot review');
  assert.equal(data.accounts.length, 1);
  assert.equal(data.accounts[0].stage, 'negotiation');
  assert.equal(data.accounts[0].stage_entered_at, at(-24 * 30), 'entered when the stage changed, not at the last re-observation');
  assert.equal(data.accounts[0].owner_user_id, 'u1', 'owner from the person when the account has none');
});
