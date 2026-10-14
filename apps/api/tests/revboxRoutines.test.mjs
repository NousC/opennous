// RevBox jobs on the workflow engine (GET-868) and RevBoxes on the Workspace plan (GET-864): the
// Jobs list's trigger label, the Results rows for routine runs with credits, the plan flag, and the
// engine accepting a revbox_delivery step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routineTriggerLabel, routineOut, revboxRoutineRuns, routineRunState, checkDeliveryMailboxes } from '../src/routes/api/revboxes.mjs';
import { getPlan } from '../src/lib/plans.mjs';
import { checkFlow, STEP_TYPES } from '../src/lib/flows.mjs';

test('RevBoxes are on for the API and Workspace plans, and still off for Free', () => {
  // The plan table itself: hasFeature is a pass-through while the paywall is off (PAYWALL in plans.mjs).
  assert.equal(getPlan('api').features.revboxes, true);
  assert.equal(getPlan('custom').features.revboxes, true);
  assert.equal(getPlan('workspace').features.revboxes, true);   // the legacy id resolves to Workspace
  assert.equal(getPlan('free').features.revboxes, false);
});

test('a routine job reads as the UI expects, with a trigger label', () => {
  const r = { id: 'r1', name: 'TU daily', enabled: false, trigger_kind: 'clock', trigger_config: { frequency: 'daily', at: '08:00' }, timezone: 'America/Toronto', last_run_at: null, steps: [] };
  assert.equal(routineTriggerLabel(r), 'Every day at 08:00 (Toronto)');
  assert.equal(routineTriggerLabel({ ...r, trigger_config: { frequency: 'weekly', at: '09:30' }, timezone: 'UTC' }), 'Every Monday at 09:30 (UTC)');
  assert.equal(routineTriggerLabel({ trigger_kind: 'before_meeting', trigger_config: { offset: 60 } }), '60 minutes before a meeting');
  assert.equal(routineTriggerLabel({ trigger_kind: 'deal_closed_won', trigger_config: {} }), 'When a deal is won');
  // Several signals (GET-873): every one of them.
  assert.equal(routineTriggerLabel({ trigger_kind: 'deal_closed_won', trigger_config: { signal_keys: ['deal.won', 'deal.lost'], also: [{ kind: 'deal_closed_lost', config: {} }] } }), 'When a deal is won or lost');
  assert.equal(routineTriggerLabel({ trigger_kind: 'call_ended', trigger_config: { also: [{ kind: 'deal_closed_lost', config: {} }] } }), 'When a call ends or a deal is lost');
  assert.equal(routineTriggerLabel({ trigger_kind: 'deal_closed_won', trigger_config: { signal_keys: ['deal.won'] } }), 'When a deal is won');
  const out = routineOut(r);
  assert.equal('plan' in out, false);
  assert.equal(out.trigger_label, 'Every day at 08:00 (Toronto)');
  for (const k of ['id', 'name', 'enabled', 'trigger_kind', 'trigger_config', 'timezone', 'last_run_at']) assert.ok(k in out, k);
});

test('Results include the box routines\' runs with job_id and credits', async () => {
  const runs = [
    { id: '11111111-1111-1111-1111-111111111111', routine_id: 'r1', workspace_id: 'ws', status: 'ok', started_at: '2026-10-14T12:00:00Z', step_log: [], state: { test: true } },
    { id: '22222222-2222-2222-2222-222222222222', routine_id: 'other', workspace_id: 'ws', status: 'ok', started_at: '2026-10-14T12:00:00Z', step_log: [] },
  ];
  const usage = [{ request_id: 'automation-run:11111111-1111-1111-1111-111111111111:step:2', cost_usd: 0.012, occurred_at: '2026-10-14T12:00:01Z' }];
  const sb = { from(table) {
    const filters = [];
    const q = {
      select: () => q, order: () => q, limit: () => q, gte: () => q, range: () => q,
      eq: (k, v) => { filters.push(r => r[k] === v); return q; },
      in: (k, vs) => { filters.push(r => vs.includes(r[k])); return q; },
      like: () => q,
      then: (ok) => Promise.resolve({ data: (table === 'llm_usage' ? usage : runs).filter(r => table === 'llm_usage' || filters.every(f => f(r))), error: null }).then(ok),
    };
    return q;
  } };
  const rows = await revboxRoutineRuns(sb, 'ws', [{ id: 'r1', name: 'TU daily' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].job_id, 'r1');
  assert.equal(rows[0].job_name, 'TU daily');
  assert.equal(rows[0].kind, 'routine');
  assert.equal(rows[0].test, true);
  assert.equal(rows[0].credits, 3);   // $0.012 at one credit per $0.005, rounded up
});

test('the automation API accepts a revbox_delivery step', () => {
  assert.ok(STEP_TYPES.has('revbox_delivery'));
  assert.equal(checkFlow({ steps: [{ id: 'a', type: 'agent', config: { prompt: 'x' } }, { id: 'box_delivery', type: 'revbox_delivery', config: {} }] }).ok, true);
});

test('routine runs come back in the Results Run shape: state, result, deliveries (the Results tab reads these)', async () => {
  const runs = [
    { id: 'run-ok', routine_id: 'r1', workspace_id: 'ws', status: 'ok', started_at: '2026-10-14T12:00:00Z', document_id: 'doc-ok', step_log: [
      { step: 'summary', status: 'ok' },
      { step: 'box_delivery', status: 'ok', deliveries: [{ id: 'dest1', kind: 'slack', target: '#cs', ok: true }, { kind: 'email', target: 'vp@x.com', ok: false, error: 'bounced' }] },
    ] },
    { id: 'run-hidden', routine_id: 'r1', workspace_id: 'ws', status: 'error', error: 'boom', started_at: '2026-10-14T11:00:00Z', document_id: 'doc-hidden', step_log: null },
    { id: 'run-wait', routine_id: 'r1', workspace_id: 'ws', status: 'awaiting_approval', started_at: '2026-10-14T10:00:00Z', step_log: [] },
    { id: 'run-live', routine_id: 'r1', workspace_id: 'ws', status: 'running', started_at: '2026-10-14T09:00:00Z' },
  ];
  const docs = [
    { id: 'doc-ok', workspace_id: 'ws', title: 'Credit Check daily', body_md: 'All dealers up.', subject_entity_id: 'acct-a', status: 'active' },
    { id: 'doc-hidden', workspace_id: 'ws', title: 'Hidden', body_md: 'secret', subject_entity_id: 'acct-b', status: 'active' },
  ];
  const sb = { from(table) {
    const filters = [];
    const q = {
      select: () => q, order: () => q, limit: () => q, gte: () => q, range: () => q, like: () => q,
      eq: (k, v) => { filters.push(r => r[k] === v); return q; },
      neq: (k, v) => { filters.push(r => r[k] !== v); return q; },
      in: (k, vs) => { filters.push(r => vs.includes(r[k])); return q; },
      then: (ok) => Promise.resolve({ data: (table === 'llm_usage' ? [] : table === 'documents' ? docs : runs).filter(r => table === 'llm_usage' || filters.every(f => f(r))), error: null }).then(ok),
    };
    return q;
  } };
  const rows = await revboxRoutineRuns(sb, 'ws', [{ id: 'r1', name: 'TU daily' }], { allowed: new Set(['acct-a']) });
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(by['run-ok'].state, 'completed');
  assert.deepEqual(by['run-ok'].result, { title: 'Credit Check daily', body: 'All dealers up.', kind: 'report' });
  assert.deepEqual(by['run-ok'].deliveries, [
    { id: 'dest1', state: 'sent', error: null, destination: { kind: 'slack', target: '#cs' } },
    { id: 'run-ok:1', state: 'failed', error: 'bounced', destination: { kind: 'email', target: 'vp@x.com' } },
  ]);
  assert.equal(by['run-ok'].job_id, 'r1');
  assert.equal(by['run-ok'].credits, 0);
  assert.equal(by['run-ok'].created_at, '2026-10-14T12:00:00Z');
  // A document about an account the viewer cannot see is not shown.
  assert.equal(by['run-hidden'].state, 'failed');
  assert.equal(by['run-hidden'].result, null);
  assert.equal(by['run-hidden'].document_id, null);
  assert.deepEqual(by['run-hidden'].deliveries, []);
  assert.equal(by['run-wait'].state, 'needs_review');
  assert.equal(by['run-live'].state, 'running');
  assert.deepEqual(by['run-live'].deliveries, []);
  for (const r of rows) for (const k of ['id', 'job_id', 'state', 'created_at', 'error', 'result', 'deliveries', 'credits']) assert.ok(k in r, `${r.id} has ${k}`);
  // Unrestricted viewers see the hidden-account document.
  const all = await revboxRoutineRuns(sb, 'ws', [{ id: 'r1', name: 'TU daily' }]);
  assert.equal(all.find(r => r.id === 'run-hidden').result.title, 'Hidden');
});

test('routine run status -> Results state', () => {
  assert.equal(routineRunState('running'), 'running');
  assert.equal(routineRunState('waiting'), 'running');
  assert.equal(routineRunState('ok'), 'completed');
  assert.equal(routineRunState('completed'), 'completed');
  assert.equal(routineRunState('error'), 'failed');
  assert.equal(routineRunState('failed'), 'failed');
  assert.equal(routineRunState('awaiting_approval'), 'needs_review');
  assert.equal(routineRunState('rejected'), 'rejected');
  assert.equal(routineRunState(null), 'running');
});

test('a Gmail destination saved on a box must be one of the saver\'s own mailboxes; its address is set by the server', () => {
  const mine = [{ id: 'mbx-me', kind: 'gmail', email: 'me@acme.example' }];
  // New: only my own mailbox, and the address comes from the lookup, not the client.
  const out = checkDeliveryMailboxes([{ id: 'g1', kind: 'gmail', target: 'mbx-me', to: 'vp@acme.example', mailbox_email: 'forged@evil.example' }], [], mine);
  assert.equal(out[0].mailbox_email, 'me@acme.example');
  assert.throws(() => checkDeliveryMailboxes([{ id: 'g1', kind: 'gmail', target: 'mbx-colleague', to: 'vp@acme.example' }], [], mine), e => e.status === 400 && /your own/.test(e.message));
  // Pointing an existing destination at a colleague's mailbox is refused the same way.
  const current = [{ id: 'g2', kind: 'gmail', target: 'mbx-colleague', to: 'vp@acme.example', mailbox_email: 'colleague@acme.example' }];
  assert.throws(() => checkDeliveryMailboxes([{ ...current[0], target: 'mbx-other' }], current, mine), e => e.status === 400);
  // Unchanged, another editor's destination stays as it was (editing the box's name re-sends the whole list).
  const kept = checkDeliveryMailboxes([{ ...current[0], to: 'cfo@acme.example', mailbox_email: 'forged@evil.example' }], current, mine);
  assert.equal(kept[0].mailbox_email, 'colleague@acme.example');
  assert.equal(kept[0].to, 'cfo@acme.example');
  // Not chosen yet is fine; other kinds pass through without a mailbox address.
  assert.deepEqual(checkDeliveryMailboxes([{ id: 'g3', kind: 'gmail', target: '', to: '' }, { id: 'e1', kind: 'email', target: 'vp@acme.example', mailbox_email: 'x' }], [], []),
    [{ id: 'g3', kind: 'gmail', target: '', to: '' }, { id: 'e1', kind: 'email', target: 'vp@acme.example' }]);
});

test('Cc on mail destinations passes the mailbox check untouched (GET-868)', () => {
  const mine = [{ id: 'mbx-me', kind: 'gmail', email: 'me@acme.example' }];
  const out = checkDeliveryMailboxes([
    { id: 'g1', kind: 'gmail', target: 'mbx-me', to: 'vp@acme.example', cc: 'cfo@acme.example' },
    { id: 'e1', kind: 'email', target: 'vp@acme.example', to: 'vp@acme.example', cc: 'ops@acme.example' },
  ], [], mine);
  assert.deepEqual(out.map(d => [d.kind, d.to, d.cc]), [['gmail', 'vp@acme.example', 'cfo@acme.example'], ['email', 'vp@acme.example', 'ops@acme.example']]);
  assert.equal(out[0].mailbox_email, 'me@acme.example');
});
