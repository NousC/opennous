// RevBox page polish (GET-872): the Owners rail's people with photos, the accounts a box's jobs
// touched in their recent runs (visibility-filtered), and the built-in jobs a box lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boxSlackFormat } from '../src/services/slackFormats.mjs';
import { revboxDetails, revboxPeople, revboxRunAccounts, revboxBuiltinTaken, revboxBuiltinActivity, validateRevboxPatch, patchRevbox, builtinJobsOf, REVBOX_BUILTIN_KEYS } from '../src/db/revboxes.mjs';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString();

function database(tables, { failOn = {} } = {}) {
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select(cols) { this.cols = cols; return this; } order() { return this; } limit() { return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    in(k, vs) { this.filters.push(r => vs.includes(r[k])); return this; }
    gte(k, v) { this.filters.push(r => String(r[k] ?? '') >= v); return this; }
    update(v) { this.updateValue = v; return this; }
    result(single) {
      if (failOn[this.table] && String(this.cols ?? '').includes(failOn[this.table].col)) return { data: null, error: failOn[this.table].error };
      let values = (tables[this.table] ?? []).filter(r => this.filters.every(f => f(r)));
      if (this.updateValue) for (const r of values) Object.assign(r, structuredClone(this.updateValue));
      return { data: structuredClone(single ? values[0] ?? null : values), error: null };
    }
    maybeSingle() { return Promise.resolve(this.result(true)); } single() { return this.maybeSingle(); }
    then(ok, ko) { return Promise.resolve(this.result(false)).then(ok, ko); }
  }
  return { tables, from: t => new Query(t) };
}

const world = () => ({
  workspace_members: [{ workspace_id: 'ws', user_id: 'owner' }, { workspace_id: 'ws', user_id: 'ed' }],
  users: [
    { id: 'owner', name: 'Avery Castellan', email: 'avery@x.com', profile_picture_url: 'https://img/avery.png' },
    { id: 'ed', name: null, email: 'jordan@x.com', profile_picture_url: '' },
  ],
  revboxes: [
    { id: 'box', workspace_id: 'ws', owner_id: 'owner', shared: false, name: 'Credit Check Reporting', revision: 1, scope: { mode: 'selected', account_ids: [], min_icp: 70 }, blocks: [], delivery: [], builtin_jobs: ['stale_deal'] },
    { id: 'other', workspace_id: 'ws', owner_id: 'owner', shared: false, name: 'Private box', revision: 1, builtin_jobs: ['deal_risk', 'bogus'] },
  ],
  revbox_members: [{ workspace_id: 'ws', revbox_id: 'box', user_id: 'ed', role: 'editor' }],
  revbox_context: [], revbox_jobs: [],
  agent_routine_runs: [
    { id: 'r1', workspace_id: 'ws', routine_id: 'job', started_at: ago(1), entity_id: null, document_id: 'd1' },
    { id: 'r2', workspace_id: 'ws', routine_id: 'job', started_at: ago(2), entity_id: 'acct-a', document_id: null },
    { id: 'r3', workspace_id: 'ws', routine_id: 'job', started_at: ago(3), entity_id: 'person-b', document_id: null },
    { id: 'old', workspace_id: 'ws', routine_id: 'job', started_at: ago(45), entity_id: 'acct-c', document_id: null },
    { id: 'else', workspace_id: 'ws', routine_id: 'not-this-box', started_at: ago(1), entity_id: 'acct-c', document_id: null },
  ],
  revbox_runs: [{ id: 'legacy', workspace_id: 'ws', revbox_id: 'box', created_at: ago(5), account_ids: ['acct-a'] }],
  documents: [{ id: 'd1', workspace_id: 'ws', subject_entity_id: 'acct-a' }],
  document_links: [
    { workspace_id: 'ws', document_id: 'd1', target_entity_id: 'acct-b', kind: 'mentions' },
    { workspace_id: 'ws', document_id: 'd1', target_entity_id: 'acct-hidden', kind: 'about' },
    { workspace_id: 'ws', document_id: 'd1', target_entity_id: 'acct-c', kind: 'supersedes' },
  ],
  entity_list_rows: [
    { workspace_id: 'ws', entity_id: 'acct-a', kind: 'account', name: 'Northside Motors', domain: 'northside.example', company_id: null },
    { workspace_id: 'ws', entity_id: 'acct-b', kind: 'account', name: 'Lakeshore Auto', domain: null, company_id: null },
    { workspace_id: 'ws', entity_id: 'acct-c', kind: 'account', name: 'Old Dealer', domain: null, company_id: null },
    { workspace_id: 'ws', entity_id: 'acct-hidden', kind: 'account', name: 'Hidden Co', domain: null, company_id: null },
    { workspace_id: 'ws', entity_id: 'person-b', kind: 'person', name: 'Pat', domain: null, company_id: 'acct-b' },
  ],
});

test('the Owners rail gets each person with their photo, owner first, and initials when there is none', async () => {
  const sb = database(world());
  const people = await revboxPeople(sb, { owner_id: 'owner', members: [{ user_id: 'ed', role: 'editor' }] });
  assert.deepEqual(people, [
    { id: 'owner', role: 'owner', name: 'Avery Castellan', email: 'avery@x.com', avatar_url: 'https://img/avery.png' },
    { id: 'ed', role: 'editor', name: 'jordan', email: 'jordan@x.com', avatar_url: null },
  ]);
  const detail = await revboxDetails(sb, 'ws', 'ed', 'box');
  assert.equal(detail.people[0].avatar_url, 'https://img/avery.png');
  assert.deepEqual(detail.box.builtin_jobs, ['stale_deal']);
});

test('run accounts: entity ids, document subjects and about/mentions links, a person for its company, last 30 days, most runs first', async () => {
  const sb = database(world());
  const out = await revboxRunAccounts(sb, 'ws', { revboxId: 'box', routineIds: ['job'], now: NOW });
  assert.equal(out.runs, 4);   // r1, r2, r3 and the legacy run; not the 45-day-old one or another box's
  assert.equal(out.linked, true);
  assert.deepEqual(out.accounts, [
    { id: 'acct-a', name: 'Northside Motors', domain: 'northside.example', runs: 3 },
    { id: 'acct-b', name: 'Lakeshore Auto', domain: null, runs: 2 },
    { id: 'acct-hidden', name: 'Hidden Co', domain: null, runs: 1 },
  ]);
});

test('run accounts are the viewer-visible ones only', async () => {
  const sb = database(world());
  const out = await revboxRunAccounts(sb, 'ws', { revboxId: 'box', routineIds: ['job'], allowed: new Set(['acct-a', 'acct-b']), now: NOW });
  assert.deepEqual(out.accounts.map(a => a.id), ['acct-a', 'acct-b']);
  const none = await revboxRunAccounts(sb, 'ws', { revboxId: 'box', routineIds: ['job'], allowed: new Set(), now: NOW });
  assert.deepEqual(none.accounts, []);
  assert.equal(none.linked, true);   // runs did name accounts; the viewer just sees none of them
});

test('runs that name no account read as not linked, not as zero accounts', async () => {
  const w = world();
  w.agent_routine_runs = [{ id: 'r', workspace_id: 'ws', routine_id: 'job', started_at: ago(1), entity_id: null, document_id: 'dx' }];
  w.documents = [{ id: 'dx', workspace_id: 'ws', subject_entity_id: null }];
  w.revbox_runs = [];
  const out = await revboxRunAccounts(database(w), 'ws', { revboxId: 'box', routineIds: ['job'], now: NOW });
  assert.deepEqual(out, { accounts: [], runs: 1, linked: false });
});

test('built-in jobs: known keys only, no duplicates', () => {
  assert.deepEqual(REVBOX_BUILTIN_KEYS, ['sales_follow_up', 'stale_deal', 'deal_signals', 'deal_risk', 'expansion']);
  assert.equal(validateRevboxPatch({ revision: 1, builtin_jobs: ['stale_deal', 'expansion'] }), null);
  assert.match(validateRevboxPatch({ revision: 1, builtin_jobs: ['nope'] }), /built-in/);
  assert.match(validateRevboxPatch({ revision: 1, builtin_jobs: ['stale_deal', 'stale_deal'] }), /built-in/);
  assert.match(validateRevboxPatch({ revision: 1, builtin_jobs: 'stale_deal' }), /built-in/);
  assert.deepEqual(builtinJobsOf({ builtin_jobs: ['deal_risk', 'bogus'] }), ['deal_risk']);
  assert.deepEqual(builtinJobsOf({}), []);   // before the migration
});

test('a built-in job is in one box per workspace: adding one another box lists is a 409 naming it', async () => {
  const sb = database(world());
  await assert.rejects(patchRevbox(sb, 'ws', 'owner', 'box', { revision: 1, builtin_jobs: ['stale_deal', 'deal_risk'] }), e => e.status === 409 && /Deal risk detection is already in the RevBox "Private box"/.test(e.message));
  // Someone who cannot open that box is not told its name.
  await assert.rejects(patchRevbox(sb, 'ws', 'ed', 'box', { revision: 1, builtin_jobs: ['deal_risk'] }), e => e.status === 409 && /already in another RevBox/.test(e.message));
  const saved = await patchRevbox(sb, 'ws', 'owner', 'box', { revision: 1, builtin_jobs: ['stale_deal', 'expansion'] });
  assert.deepEqual(saved.builtin_jobs, ['stale_deal', 'expansion']);
  // Removing one is always allowed (it keeps running; it just leaves the box).
  const removed = await patchRevbox(sb, 'ws', 'owner', 'box', { revision: 2, builtin_jobs: [] });
  assert.deepEqual(removed.builtin_jobs, []);
});

test('built-in taken: other boxes only, the name hidden when the viewer cannot open the box, empty before the migration', async () => {
  assert.deepEqual(await revboxBuiltinTaken(database(world()), 'ws', 'ed', 'box'), [{ key: 'deal_risk', box_id: 'other', box_name: null }]);
  assert.deepEqual(await revboxBuiltinTaken(database(world()), 'ws', 'owner', 'box'), [{ key: 'deal_risk', box_id: 'other', box_name: 'Private box' }]);
  const missing = database(world(), { failOn: { revboxes: { col: 'builtin_jobs', error: { code: '42703', message: 'column revboxes.builtin_jobs does not exist' } } } });
  assert.deepEqual(await revboxBuiltinTaken(missing, 'ws', 'owner', 'box'), []);
});

test('built-in activity: drafts in the last 30 days and the latest, from follow_ups and the detector ledger', async () => {
  const sb = database({
    follow_ups: [{ workspace_id: 'ws', account_entity_id: 'acct-a', created_at: ago(2) }, { workspace_id: 'ws', account_entity_id: 'acct-x', created_at: ago(1) }, { workspace_id: 'ws', account_entity_id: 'acct-a', created_at: ago(40) }],
    ri_recommendations: [
      { workspace_id: 'ws', category: 'automation', rec_key: 'automation.deal_signal', target_type: 'account', target_id: 'acct-a', updated_at: ago(3) },
      { workspace_id: 'ws', category: 'automation', rec_key: 'automation.stale_deal', target_type: 'deal', target_id: 'deal-1', updated_at: ago(4) },
      { workspace_id: 'ws', category: 'open', rec_key: 'automation.stale_deal', target_type: 'deal', target_id: 'deal-2', updated_at: ago(1) },
    ],
  });
  const all = await revboxBuiltinActivity(sb, 'ws', ['sales_follow_up', 'deal_signals', 'stale_deal'], { now: NOW });
  assert.deepEqual(all, [
    { key: 'sales_follow_up', drafts: 2, last_at: ago(1) },
    { key: 'stale_deal', drafts: 1, last_at: ago(4) },
    { key: 'deal_signals', drafts: 1, last_at: ago(3) },
  ]);
  const scoped = await revboxBuiltinActivity(sb, 'ws', ['sales_follow_up', 'deal_signals'], { allowed: new Set(['acct-a']), now: NOW });
  assert.deepEqual(scoped.map(a => a.drafts), [1, 1]);
});

// ── The Slack layout a box delivery posts in: decided by the job, not the destination ──────

test('box Slack layout: destination (back-compat), then the delivery step, then the job\'s Slack step, then by trigger', () => {
  const steps = [{ id: 'a', type: 'agent' }, { id: 'post', type: 'slack', config: { format: 'digest' } }];
  assert.equal(boxSlackFormat({ destination: { format: 'alert' }, deliveryStep: { config: { format: 'report' } }, steps, triggerKind: 'clock' }), 'alert');
  assert.equal(boxSlackFormat({ destination: {}, deliveryStep: { config: { format: 'handoff' } }, steps, triggerKind: 'clock' }), 'handoff');
  assert.equal(boxSlackFormat({ destination: {}, deliveryStep: { config: {} }, steps, triggerKind: 'clock' }), 'digest');
  assert.equal(boxSlackFormat({ destination: {}, deliveryStep: { config: {} }, steps: [], triggerKind: 'clock' }), 'report');
  assert.equal(boxSlackFormat({ destination: {}, deliveryStep: { config: {} }, steps: [], triggerKind: 'deal_closed_won' }), 'notification');
  // Never approval (nothing runs after box delivery for its buttons to release); unknown values fall through.
  assert.equal(boxSlackFormat({ destination: { format: 'approval' }, deliveryStep: { config: { format: 'bogus' } }, steps: [{ type: 'slack', config: { format: 'approval' } }], triggerKind: 'clock' }), 'report');
  assert.equal(boxSlackFormat(), 'notification');
});
