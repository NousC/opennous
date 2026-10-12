// A draft a canvas automation's step queued (GET-543) is labelled with that automation in Priorities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originOf } from '../src/lib/actionOrigin.mjs';

test('a step-runner draft carries its automation\'s name and why', () => {
  const decisions = new Map([['a1', { surface: 'automation', payload: { automation_name: 'Follow-up after every call', why: 'After the call: Pricing review', routine_id: 'r1' } }]]);
  const o = originOf({ id: 'a1', created_at: '2026-10-05T10:00:00Z' }, { decisions });
  assert.equal(o.source, 'routine');
  assert.equal(o.name, 'Follow-up after every call');
  assert.equal(o.why, 'After the call: Pricing review');
  assert.equal(o.routine_id, 'r1');
});

test('a detector draft still resolves through its ledger row first', () => {
  const recs = new Map([['rec1', { id: 'rec1', rec_key: 'automation.deal_signal', evidence: { why: 'Raised an objection' } }]]);
  const decisions = new Map([['a2', { surface: 'automation', payload: { automation_name: 'Deal signals' } }]]);
  const o = originOf({ id: 'a2', rec_id: 'rec1' }, { recs, decisions });
  assert.equal(o.source, 'rec');
});

import { workspaceAutomationLimit } from '../src/routes/api/automations.mjs';

test('a workspace on the unlimited list has no automation limit; every other keeps its plan\'s', () => {
  assert.equal(workspaceAutomationLimit('ws-ours', 'api', 'ws-other, ws-ours'), null);
  assert.equal(workspaceAutomationLimit('ws-x', 'api', 'ws-ours'), 5);
  assert.equal(workspaceAutomationLimit('ws-x', 'api', ''), 5);
});
