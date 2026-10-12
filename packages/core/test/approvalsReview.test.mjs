// The approvals review and the prompts behind it (GET-729): a run paused before per-task approval
// still shows its HubSpot tasks one by one; a call's described product behaviour is never a task;
// every email draft is short.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/approvalsReview.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTasks } from '../dist/services/automationRun.mjs';
import { buildCommitmentsPrompt, buildHealthReadPrompt } from '../dist/services/accountHealth.js';
import { EMAIL_DRAFT_SYSTEM } from '../dist/services/emailDraftBrief.mjs';

const ctx = { call: { nextSteps: [{ title: 'Send Theo the pilot terms', due_at: null }, { title: 'Chase Mira on the data room', theirs: true }, { title: 'Book the follow-up', due_at: '2026-10-09T00:00:00Z' }] } };

test('an old paused HubSpot step gets its tasks back, keyed as the runner reads them', () => {
  const [it] = withTasks([{ index: 2, step: 'Step 3 · HubSpot · Create a task', type: 'hubspot', rows: [{ label: 'Tasks', value: '• a' }] }], ctx);
  assert.deepEqual(it.tasks.map(t => [t.key, t.title]), [[0, 'Send Theo the pilot terms'], [1, 'Book the follow-up']]);
  assert.equal(it.action, 'task');
});

test('items that already carry tasks, or are not tasks, are left alone', () => {
  const has = { index: 1, type: 'hubspot', rows: [{ label: 'Tasks', value: '' }], tasks: [{ key: 0, title: 'x', due_at: null }] };
  const mail = { index: 0, type: 'gmail', rows: [{ label: 'To', value: 'a@b.example' }] };
  assert.deepEqual(withTasks([has, mail], ctx), [has, mail]);
  const none = { index: 1, type: 'hubspot', rows: [{ label: 'Tasks', value: '' }] };
  assert.deepEqual(withTasks([none], {}), [none]);
});

test('both commitment reads refuse a description of how the product works', () => {
  for (const p of [buildCommitmentsPrompt('t'), buildHealthReadPrompt('t')]) {
    assert.match(p, /morning digest after the nightly run/);
    assert.match(p, /named PERSON/);
  }
});

test('the email brief asks for a short email', () => {
  assert.match(EMAIL_DRAFT_SYSTEM, /never more than 120/);
  assert.match(EMAIL_DRAFT_SYSTEM, /Do not recap the whole call/);
});

test('a skipped task is kept on the paused run, so a reload shows it decided (GET-735)', async () => {
  const { saveApprovalChoices } = await import('../dist/services/automationRun.mjs');
  let saved = null;
  const run = { id: 'run1', status: 'awaiting_approval', state: { bundle: [{ index: 1 }] } };
  const db = { from: () => { const q = { select: () => q, eq: () => q, update: (r) => { saved = r; return q; }, maybeSingle: async () => ({ data: run }), then: (ok) => Promise.resolve({}).then(ok) }; return q; } };
  const out = await saveApprovalChoices(db, 'ws', 'run1', { choices: { 't1:0': 'skip', 'bad key!': 'skip', 't1:1': 'maybe' }, send: { i0: true }, edits: { i0: { to: 'a@b.example', subject: 'S', body: 'B' } } });
  assert.equal(out.ok, true);
  assert.deepEqual(saved.state.partial.choices, { 't1:0': 'skip' });
  assert.deepEqual(saved.state.partial.send, { i0: true });
  assert.equal(saved.state.partial.edits.i0.to, 'a@b.example');
  assert.deepEqual(saved.state.bundle, [{ index: 1 }], 'the rest of the paused state is untouched');
  const done = { from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { ...run, status: 'ok' } }) }; return q; } };
  assert.equal((await saveApprovalChoices(done, 'ws', 'run1', {})).error, 'not_waiting');
});

test('test triggers: one row per call however many people were on it, newest first, with the account', async () => {
  const { testTriggers } = await import('../dist/services/automationRun.mjs');
  const rows = {
    observations: [
      { entity_id: 'p1', source: 'granola', observed_at: '2026-10-05T10:00:00Z', raw: { title: 'Theo x Dana' } },
      { entity_id: 'p2', source: 'granola', observed_at: '2026-10-05T10:00:00Z', raw: { title: 'Theo x Dana' } },
      { entity_id: 'p3', source: 'granola', observed_at: '2026-10-04T09:00:00Z', raw: { title: 'Pricing' } },
    ],
    contacts: [{ id: 'p1', company_id: 'c1' }, { id: 'p2', company_id: 'c1' }, { id: 'p3', company_id: null }],
    companies: [{ id: 'c1', name: 'Ridgeway Haulage', domain: 'ridgeway-haulage.example' }],
  };
  const db = { from: (t) => { const q = { select: () => q, eq: () => q, in: () => q, not: () => q, order: () => q, limit: () => q, then: (ok) => Promise.resolve({ data: rows[t] ?? [] }).then(ok) }; return q; } };
  const list = await testTriggers(db, 'ws', { trigger_kind: 'call_ended', trigger_config: { tools: ['granola'] } });
  assert.deepEqual(list.map(x => [x.id, x.label, x.account?.name ?? null]), [
    ['granola|2026-10-05T10:00:00Z', 'Theo x Dana', 'Ridgeway Haulage'],
    ['granola|2026-10-04T09:00:00Z', 'Pricing', null],
  ]);
});

test('an AI step never reads more than the ceiling, however much an account holds (GET-739)', async () => {
  const { fitMaterial, MATERIAL_CHARS } = await import('../dist/services/automationRun.mjs');
  const big = 'x'.repeat(3_000);
  const m = { account: { name: 'OpenNous' }, intel: Array.from({ length: 35 }, (_, i) => ({ content: `${i} ${big}` })),
    recent_activity: [{ what: 'call' }], this_call: { transcript: 'y'.repeat(60_000) } };
  const out = fitMaterial(m);
  assert.ok(JSON.stringify(out).length <= MATERIAL_CHARS, `got ${JSON.stringify(out).length}`);
  assert.equal(out.account.name, 'OpenNous');
  assert.equal(out.intel[0].content.startsWith('0 '), true, 'the newest intel is kept first');
  const small = { account: { name: 'A' }, intel: [{ content: 'short' }], recent_activity: [] };
  assert.equal(fitMaterial(small), small, 'under the ceiling nothing changes');
});
