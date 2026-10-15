// GET-873: a held Test run reads in Results as a Test with what it would have sent, a scheduled run's
// output comes from its AI step's document, and the Accounts page pages a RevBox's scoped accounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revboxRoutineRuns, heldActions, routineRunDeliveries } from '../src/routes/api/revboxes.mjs';
import { revboxAccountPage } from '../src/routes/api/companies.mjs';

const fakeSb = (runs, docs) => ({ from(table) {
  const filters = [];
  const q = {
    select: () => q, order: () => q, limit: () => q, gte: () => q, range: () => q, like: () => q,
    eq: (k, v) => { filters.push(r => r[k] === v); return q; },
    neq: (k, v) => { filters.push(r => r[k] !== v); return q; },
    in: (k, vs) => { filters.push(r => vs.includes(r[k])); return q; },
    then: (ok) => Promise.resolve({ data: (table === 'llm_usage' ? [] : table === 'documents' ? docs : runs).filter(r => table === 'llm_usage' || filters.every(f => f(r))), error: null }).then(ok),
  };
  return q;
} });

test('a held Test run comes back as a Test, its output from the AI step, with what it would have sent', async () => {
  const runs = [{ id: 'run-t', routine_id: 'r1', workspace_id: 'ws', status: 'ok', started_at: '2026-10-14T12:00:00Z', document_id: null,
    state: { test: true, held: true, trigger: { kind: 'clock', label: 'Run now' } },
    step_log: [
      { step: 1, type: 'agent', name: 'AI', status: 'ok', detail: 'Wrote it', document_id: 'doc-1' },
      { step: 2, type: 'slack', name: 'Slack', status: 'held', detail: 'Would post to #ops-daily', held: true, preview: [{ label: 'Channel', value: 'ops-daily' }, { label: 'Message', value: 'Account A up.' }] },
      { step: 3, type: 'gmail', name: 'Gmail', status: 'held', detail: 'Would draft to lead@example.com', held: true, preview: [] },
    ] }];
  const docs = [{ id: 'doc-1', workspace_id: 'ws', title: 'Daily usage', body_md: 'Account A up.', subject_entity_id: null, status: 'active' }];
  const [row] = await revboxRoutineRuns(fakeSb(runs, docs), 'ws', [{ id: 'r1', name: 'Usage daily' }]);
  assert.equal(row.test, true);
  assert.equal(row.held, true);
  assert.equal(row.state, 'completed');
  assert.deepEqual(row.result, { title: 'Daily usage', body: 'Account A up.', kind: 'report' });
  assert.equal(row.document_id, 'doc-1');
  assert.deepEqual(row.held_actions, [
    { step: 'Slack', text: 'Would post to #ops-daily', rows: [{ label: 'Channel', value: 'ops-daily' }, { label: 'Message', value: 'Account A up.' }] },
    { step: 'Gmail', text: 'Would draft to lead@example.com', rows: [] },
  ]);
  assert.deepEqual(row.deliveries, []);
});

test('heldActions reads only held lines and is safe on odd logs', () => {
  assert.deepEqual(heldActions(null), []);
  assert.deepEqual(heldActions([{ status: 'ok', detail: 'x' }, { status: 'held', name: 'Webhook', detail: 'Would send to the webhook at h.example', preview: [{ value: 'no label' }] }]),
    [{ step: 'Webhook', text: 'Would send to the webhook at h.example', rows: [] }]);
});

test('a box delivery Slack refused reads as what to do, not as Slack\'s code (GET-879)', () => {
  const [d, e] = routineRunDeliveries('run-1', [{ status: 'failed', deliveries: [
    { id: 'd-s', kind: 'slack', target: 'C0PRIV123', ok: false, error: 'slack_channel_not_found' },
    { id: 'd-w', kind: 'webhook', target: 'https://h.example', ok: false, error: 'webhook_503' },
  ] }]);
  assert.equal(d.error, "Slack can't see that channel. If it's private, invite the Nous app: type /invite @Nous in the channel");
  assert.equal(e.error, 'webhook_503');
});

test('a RevBox\'s scoped accounts page: search, newest activity first, stable ties, the real total', () => {
  const accounts = [
    { id: 'c', name: 'Gamma', domain: 'gamma.example', last_activity_at: null },
    { id: 'a', name: 'Alpha', domain: 'alpha.example', last_activity_at: '2026-10-10T00:00:00Z' },
    { id: 'b', name: 'Beta', domain: 'beta.example', last_activity_at: '2026-10-12T00:00:00Z' },
    { id: 'd', name: 'Delta', domain: 'delta.example', last_activity_at: '2026-10-10T00:00:00Z' },
  ];
  assert.deepEqual(revboxAccountPage(accounts), { ids: ['b', 'a', 'd', 'c'], total: 4 });
  assert.deepEqual(revboxAccountPage(accounts, { limit: 2, offset: 1 }), { ids: ['a', 'd'], total: 4 });
  assert.deepEqual(revboxAccountPage(accounts, { q: 'ALPHA' }), { ids: ['a'], total: 1 });
  assert.deepEqual(revboxAccountPage(accounts, { q: 'delta.ex' }), { ids: ['d'], total: 1 });
  assert.deepEqual(revboxAccountPage(null), { ids: [], total: 0 });
});
