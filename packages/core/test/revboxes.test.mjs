import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeRevboxPlan, validateRevboxPlan, revboxMatchesAccount } from '../src/services/revboxPlan.mjs';
import { loadRevbox, patchRevbox, saveRevboxJob, listRevboxes, validateRevboxPatch } from '../src/db/revboxes.mjs';

// Exercise tenant/role/revision guards through the actual database methods.
function database() {
  const tables = {
    workspace_members: [{ workspace_id: 'a', user_id: 'owner' }, { workspace_id: 'a', user_id: 'guest' }, { workspace_id: 'b', user_id: 'other' }],
    revboxes: [{ id: 'box-a', workspace_id: 'a', owner_id: 'owner', shared: false, name: 'Private operation', revision: 1, scope: { mode: 'selected', account_ids: [], min_icp: 70 }, blocks: [], delivery: [] }, { id: 'box-b', workspace_id: 'b', owner_id: 'other', shared: true, name: 'Other tenant', revision: 1 }],
    revbox_members: [], revbox_jobs: [], revbox_context: [],
  };
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select() { return this; } order() { return this; } limit() { return this; }
    eq(key, value) { this.filters.push(row => row[key] === value); return this; }
    insert(value) { this.insertValue = value; return this; }
    update(value) { this.updateValue = value; return this; }
    result(single = false) {
      let values = tables[this.table].filter(row => this.filters.every(f => f(row)));
      if (this.insertValue) { const value = structuredClone({ id: `new-${tables[this.table].length}`, ...this.insertValue }); tables[this.table].push(value); values = [value]; }
      if (this.updateValue) for (const row of values) Object.assign(row, structuredClone(this.updateValue));
      return { data: structuredClone(single ? values[0] ?? null : values), error: null };
    }
    maybeSingle() { return Promise.resolve(this.result(true)); } single() { return this.maybeSingle(); }
    then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject); }
  }
  return { tables, from: table => new Query(table) };
}

test('meeting follow-up is a provider-bound signal and drafts instead of sending', () => {
  const plan = proposeRevboxPlan('After every Granola meeting assigned to me, draft a follow-up in Gmail. Do not send until I review it.');
  assert.equal(plan.trigger.kind, 'call_ended'); assert.equal(plan.trigger.provider, 'granola');
  assert.ok(plan.steps.some(s => s.type === 'gmail' && /draft/i.test(s.label)));
  assert.ok(plan.steps.some(s => s.type === 'approval')); assert.equal(plan.execution_enabled, false);
});
test('daily and quarterly analytics keep a schedule and retain the instructions', () => {
  const daily = proposeRevboxPlan('Every morning at 7am create a daily update in Slack.', { timezone: 'America/New_York' });
  assert.equal(daily.trigger.at, '07:00'); assert.equal(daily.trigger.timezone, 'America/New_York');
  const quarterly = proposeRevboxPlan('Every 3 months analyze won/lost deals and deliver the report to Slack and a webhook.');
  assert.equal(quarterly.trigger.kind, 'clock'); assert.equal(quarterly.trigger.frequency, 'quarterly');
  assert.ok(quarterly.steps.some(s => s.type === 'webhook')); assert.equal(validateRevboxPlan(quarterly), null);
});
test('campaign completion resolves to the provider refresh dispatcher', () => {
  const plan=proposeRevboxPlan('When an Instantly campaign is completed, analyze the campaign');
  assert.equal(plan.trigger.kind,'campaign_completed');
  assert.equal(plan.tools.includes('instantly'),true);
});
test('invalid schedules and duplicate step identities are rejected', () => {
  const plan = proposeRevboxPlan('Every morning at 7am create a report.');
  plan.trigger.timezone = 'invented/timezone'; assert.match(validateRevboxPlan(plan), /timezone/);
  plan.trigger.timezone = 'UTC'; plan.trigger.at = '25:00'; assert.match(validateRevboxPlan(plan), /schedule/);
  plan.trigger.at = '07:00'; plan.steps[1].id = plan.steps[0].id; assert.match(validateRevboxPlan(plan), /invalid step/);
});
test('an empty selected scope never expands to all accounts; won and ICP filters are exact', () => {
  const account = { id: 'c1', won_deals: 1, lost_deals: 0, icp_score: 75 };
  assert.equal(revboxMatchesAccount({ mode: 'selected', account_ids: [] }, account), false);
  assert.equal(revboxMatchesAccount({ mode: 'won' }, account), true);
  assert.equal(revboxMatchesAccount({ mode: 'lost' }, account), false);
  assert.equal(revboxMatchesAccount({ mode: 'icp', min_icp: 80 }, account), false);
});
test('private boxes are hidden from other members and cross-tenant IDs', async () => {
  const db = database();
  await assert.rejects(loadRevbox(db, 'a', 'guest', 'box-a'), e => e.status === 404);
  await assert.rejects(loadRevbox(db, 'a', 'owner', 'box-b'), e => e.status === 404);
  await assert.rejects(loadRevbox(db, 'a', 'other', 'box-a'), e => e.status === 403);
  assert.deepEqual(await listRevboxes(db, 'a', 'guest'), []);
});
test('sharing grants read access, explicit editors can edit, only creator can share', async () => {
  const db = database(); db.tables.revboxes[0].shared = true;
  assert.equal((await loadRevbox(db, 'a', 'guest', 'box-a')).access, 'viewer');
  await assert.rejects(patchRevbox(db, 'a', 'guest', 'box-a', { name: 'Changed', revision: 1 }), e => e.status === 403);
  db.tables.revbox_members.push({ workspace_id: 'a', revbox_id: 'box-a', user_id: 'guest', role: 'editor' });
  assert.equal((await loadRevbox(db, 'a', 'guest', 'box-a', true)).access, 'editor');
  await assert.rejects(patchRevbox(db, 'a', 'guest', 'box-a', { shared: false, revision: 1 }), e => e.status === 403);
});
test('fresh membership revocation takes precedence over box ownership', async () => {
  const db = database(); db.tables.workspace_members = db.tables.workspace_members.filter(m => m.user_id !== 'owner');
  await assert.rejects(loadRevbox(db, 'a', 'owner', 'box-a'), e => e.status === 403);
});
test('stale configuration saves fail instead of overwriting another edit', async () => {
  const db = database();
  await patchRevbox(db, 'a', 'owner', 'box-a', { name: 'First edit', revision: 1 });
  await assert.rejects(patchRevbox(db, 'a', 'owner', 'box-a', { name: 'Stale edit', revision: 1 }), e => e.status === 409);
  assert.equal(db.tables.revboxes[0].name, 'First edit');
});
test('reviewed plans are versioned and remain non-executable even with forged enablement', async () => {
  const db = database(); const plan = proposeRevboxPlan('Every morning at 7am write a report.'); plan.execution_enabled = true;
  const job = await saveRevboxJob(db, 'a', 'owner', 'box-a', { name: 'Daily report', prompt: 'Every morning at 7am write a report.', plan, state: 'reviewed' });
  assert.equal(job.plan.execution_enabled, false); assert.equal(job.snapshots.length, 1);
  await assert.rejects(saveRevboxJob(db, 'a', 'owner', 'box-a', { name: 'Changed', prompt: 'Changed', plan, state: 'draft', version: 0 }, job.id), e => e.status === 409);
  assert.equal(db.tables.revbox_jobs[0].name, 'Daily report');
});
test('configuration cannot forge ownership, revisions, unsupported delivery or oversized context', () => {
  assert.ok(validateRevboxPatch({ owner_id: 'guest', revision: 1 }));
  assert.ok(validateRevboxPatch({ name: 'x', revision: -1 }));
  assert.ok(validateRevboxPatch({ delivery: [{ id: '1', kind: 'webhook', target: 'http://internal' }], revision: 1 }));
  assert.ok(validateRevboxPatch({ blocks: [{ id: '1', title: 'Voice', body: 'x'.repeat(13000) }], revision: 1 }));
});

// ── Email and Gmail box destinations (GET-868) ───────────────────────────────────
test('email and Gmail draft destinations: valid recipients only, the mailbox by id', () => {
  const ok = (delivery) => validateRevboxPatch({ delivery, revision: 1 });
  assert.equal(ok([{ id: '1', kind: 'email', target: 'vp@acme.example, cfo@acme.example' }]), null);
  assert.equal(ok([{ id: '1', kind: 'email', target: ['vp@acme.example'] }]), null);
  assert.equal(ok([{ id: '1', kind: 'email', target: '' }]), null);   // being filled in
  assert.equal(ok([{ id: '2', kind: 'gmail', target: 'mbx-1', to: 'vp@acme.example' }]), null);
  assert.equal(ok([{ id: '2', kind: 'gmail', target: '', to: '' }]), null);
  assert.match(ok([{ id: '1', kind: 'email', target: 'vp@acme.example, not-an-address' }]), /not-an-address/);
  assert.match(ok([{ id: '1', kind: 'email', target: Array.from({ length: 21 }, (_, i) => `p${i}@acme.example`) }]), /20/);
  assert.match(ok([{ id: '2', kind: 'gmail', target: 'mbx-1', to: 'someone' }]), /someone/);
  assert.ok(ok([{ id: '2', kind: 'gmail', target: 42, to: 'vp@acme.example' }]));
  assert.ok(ok([{ id: '3', kind: 'sms', target: '+15550100' }]));
});
test('email recipients are saved as one comma-separated list', async () => {
  const db = database();
  const box = await patchRevbox(db, 'a', 'owner', 'box-a', { delivery: [{ id: '1', kind: 'email', target: [' vp@acme.example', 'cfo@acme.example'] }, { id: '2', kind: 'gmail', target: 'mbx-1', to: ['vp@acme.example'] }], revision: 1 });
  assert.equal(box.delivery[0].target, 'vp@acme.example, cfo@acme.example');
  assert.equal(box.delivery[1].to, 'vp@acme.example');
});

test('mail destinations carry To and Cc (GET-868): validated, stored as one string each', async () => {
  const ok = (delivery) => validateRevboxPatch({ revision: 1, delivery });
  assert.equal(ok([{ id: 'e', kind: 'email', target: '', to: 'vp@acme.example', cc: 'cfo@acme.example, ops@acme.example' }]), null);
  assert.equal(ok([{ id: 'g', kind: 'gmail', target: 'mbx-1', to: ['vp@acme.example'], cc: ['cfo@acme.example'] }]), null);
  assert.match(ok([{ id: 'e', kind: 'email', target: '', to: 'vp@acme.example', cc: 'not-an-address' }]), /"not-an-address" is not an email address/);
  assert.match(ok([{ id: 'g', kind: 'gmail', target: 'mbx-1', to: 'vp@acme.example', cc: 5 }]), /list of email addresses/);
  const many = Array.from({ length: 15 }, (_, i) => `p${i}@acme.example`);
  assert.match(ok([{ id: 'e', kind: 'email', target: '', to: many.slice(0, 10).join(','), cc: many.slice(10).concat(many.slice(0, 6)).join(',') }]), /up to 20 people/);
  // An older client's email destination (recipients in target, no cc) still validates.
  assert.equal(ok([{ id: 'e', kind: 'email', target: 'vp@acme.example' }]), null);
  // A Slack destination picked from the list: channel id in target, its name alongside.
  assert.equal(ok([{ id: 's', kind: 'slack', target: 'C0123456', channel: 'cs-handoffs' }]), null);
  assert.match(ok([{ id: 's', kind: 'slack', target: 'C0123456', channel: 7 }]), /Slack channel/);

  const db = database();
  const box = await patchRevbox(db, 'a', 'owner', 'box-a', { revision: 1, delivery: [
    { id: 'e', kind: 'email', target: '', to: ['vp@acme.example', 'cto@acme.example'], cc: ['cfo@acme.example'] },
    { id: 'g', kind: 'gmail', target: 'mbx-1', to: 'vp@acme.example', cc: ' cfo@acme.example ; ops@acme.example ' },
  ] });
  const [e, g] = box.delivery;
  assert.deepEqual([e.to, e.target, e.cc], ['vp@acme.example, cto@acme.example', 'vp@acme.example, cto@acme.example', 'cfo@acme.example']);
  assert.deepEqual([g.to, g.cc, g.target], ['vp@acme.example', 'cfo@acme.example, ops@acme.example', 'mbx-1']);
});
