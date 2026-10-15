// A job on several signals (GET-873): trigger_kind is the primary, trigger_config.also the extra
// triggers, trigger_config.signal_keys the catalog keys. Every event runner matches `also`, one
// event runs a job once, and a schedule never combines with signals.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/multiSignalTriggers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  routineTriggers, triggerConfigsFor, routineListensTo, listensToFilter, accountSignalKinds, callRecorders, beforeMeetingOffset, primaryTriggerConfig,
} from '../dist/services/routineTriggers.mjs';
import { signalCatalog, triggersForSignals, signalKeysProblem, signalsLabel } from '../dist/services/signalCatalog.mjs';
import { validateBuilderProposal, builderRoutineColumns } from '../dist/db/revboxBuilder.mjs';
import { runAutomationsForWorkspace, processHubspotFieldChanges } from '../dist/services/automationRun.mjs';

const WON_OR_LOST = { trigger_kind: 'deal_closed_won', trigger_config: { signal_keys: ['deal.won', 'deal.lost'], also: [{ kind: 'deal_closed_lost', config: {} }] } };

test('a routine listens to its primary kind and to every `also` kind; a clock never has extras', () => {
  assert.deepEqual(routineTriggers(WON_OR_LOST), [{ kind: 'deal_closed_won', config: {} }, { kind: 'deal_closed_lost', config: {} }]);
  assert.equal(routineListensTo(WON_OR_LOST, 'deal_closed_lost'), true);
  assert.equal(routineListensTo(WON_OR_LOST, 'call_ended'), false);
  assert.deepEqual(primaryTriggerConfig({ trigger_config: { tools: ['x'], also: [], signal_keys: ['a'] } }), { tools: ['x'] });
  const clock = { trigger_kind: 'clock', trigger_config: { frequency: 'daily', also: [{ kind: 'call_ended', config: {} }] } };
  assert.equal(routineListensTo(clock, 'call_ended'), false);
  // Junk entries and solo kinds inside also are ignored.
  const junk = { trigger_kind: 'call_ended', trigger_config: { also: [null, { kind: 'clock' }, { kind: 'account_signal' }] } };
  assert.deepEqual(triggerConfigsFor(junk, 'account_signal'), [{}]);
  assert.equal(routineListensTo(junk, 'clock'), false);
});

test('the query filter finds the primary kind or the kind in also', () => {
  assert.equal(listensToFilter('call_ended'), 'trigger_kind.eq.call_ended,trigger_config->>also.like.*call_ended*');
  assert.equal(listensToFilter(['deal_closed_won', 'icp_tier_changed']), 'trigger_kind.in.(deal_closed_won,icp_tier_changed),trigger_config->>also.like.*deal_closed_won*,trigger_config->>also.like.*icp_tier_changed*');
  assert.throws(() => listensToFilter([]));
});

test('merged filters: account signals, recorders, before-meeting offsets', () => {
  assert.deepEqual(accountSignalKinds({ trigger_kind: 'account_signal', trigger_config: { signals: ['a'], also: [{ kind: 'account_signal', config: { signals: ['b', 'a'] } }] } }), ['a', 'b']);
  assert.equal(accountSignalKinds({ trigger_kind: 'deal_closed_won', trigger_config: { also: [{ kind: 'account_signal', config: {} }] } }), null);
  assert.deepEqual(accountSignalKinds({ trigger_kind: 'deal_closed_won', trigger_config: {} }), []);
  assert.deepEqual(callRecorders({ trigger_kind: 'call_ended', tools: ['Gong'], trigger_config: {} }), ['gong']);
  assert.equal(callRecorders({ trigger_kind: 'deal_closed_won', trigger_config: { also: [{ kind: 'call_ended', config: {} }] } }), null);
  assert.equal(beforeMeetingOffset({ trigger_kind: 'before_meeting', offset_minutes: 30, trigger_config: {} }), 30);
  assert.equal(beforeMeetingOffset({ trigger_kind: 'call_ended', trigger_config: { also: [{ kind: 'before_meeting', config: { offset: 90 } }] } }), 90);
  assert.equal(beforeMeetingOffset({ trigger_kind: 'clock', trigger_config: { also: [{ kind: 'before_meeting', config: {} }] } }), null);
});

test('triggersForSignals: primary + also, same kinds merged, schedule refused with signals', () => {
  const cat = signalCatalog();
  assert.deepEqual(triggersForSignals(['deal.won', 'deal.lost'], cat), { trigger_kind: 'deal_closed_won', trigger_config: { signal_keys: ['deal.won', 'deal.lost'], also: [{ kind: 'deal_closed_lost', config: {} }] } });
  assert.deepEqual(triggersForSignals(['signal.churn_risk', 'signal.buying_signal'], cat), { trigger_kind: 'account_signal', trigger_config: { signals: ['churn_risk', 'buying_signal'], signal_keys: ['signal.churn_risk', 'signal.buying_signal'] } });
  assert.deepEqual(triggersForSignals(['meeting.done:granola', 'meeting.done:fireflies'], cat).trigger_config, { tools: ['granola', 'fireflies'], signal_keys: ['meeting.done:granola', 'meeting.done:fireflies'] });
  assert.deepEqual(triggersForSignals(['meeting.done:granola', 'meeting.done'], cat).trigger_config, { signal_keys: ['meeting.done:granola', 'meeting.done'] });
  assert.deepEqual(triggersForSignals([], cat), { trigger_kind: 'clock', trigger_config: {} });
  assert.equal(triggersForSignals(['schedule', 'deal.won'], cat), null);
  assert.match(signalKeysProblem(['schedule', 'deal.won'], cat), /schedule cannot be combined/);
  assert.match(signalKeysProblem(['deal.nope'], cat), /"deal\.nope" is not in the signal catalog/);
  assert.equal(triggersForSignals(['deal.nope', 'deal.won'], cat), null);
});

test('labels: one signal is its label, several read as a sentence', () => {
  const cat = signalCatalog();
  assert.equal(signalsLabel(['deal.won'], cat), 'Deal won');
  assert.equal(signalsLabel(['deal.won', 'deal.lost'], cat), 'When a deal is won or lost');
  assert.equal(signalsLabel(['meeting.done:granola', 'signal.churn_risk', 'signal.buying_signal'], cat), 'When a Granola meeting ends or an account shows churn risk or buying signal');
  assert.equal(signalsLabel([], cat), 'On a schedule');
});

const proposal = (trigger) => ({
  name: 'Deal closed write-up', summary: 'x', trigger,
  steps: [{ id: 'w', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Write it up.' } }],
  display: [{ step_id: 'w', tool: 'ai', title: 'Write it up' }],
});

test('validation accepts a multi-signal proposal and saves signal_keys beside also', () => {
  const t = { signal_key: 'deal.won', signal_keys: ['deal.won', 'deal.lost'], kind: 'deal_closed_won', config: { also: [{ kind: 'deal_closed_lost', config: {} }] }, label: 'When a deal is won or lost' };
  const v = validateBuilderProposal(proposal(t));
  assert.equal(v.ok, true, v.errors?.join(' '));
  const cols = builderRoutineColumns(proposal(t), v);
  assert.equal(cols.trigger_kind, 'deal_closed_won');
  assert.deepEqual(cols.trigger_config, { also: [{ kind: 'deal_closed_lost', config: {} }], signal_keys: ['deal.won', 'deal.lost'] });
});

test('validation refuses a schedule with signals, a bad extra trigger and a malformed also', () => {
  const clock = validateBuilderProposal(proposal({ kind: 'clock', config: { frequency: 'daily', at: '08:00', also: [{ kind: 'deal_closed_won', config: {} }] } }));
  assert.equal(clock.ok, false);
  assert.ok(clock.errors.some(e => /schedule cannot be combined/.test(e)));
  const solo = validateBuilderProposal(proposal({ kind: 'deal_closed_won', config: { also: [{ kind: 'clock', config: {} }] } }));
  assert.ok(solo.errors.some(e => /"clock" cannot be combined/.test(e)));
  const hs = validateBuilderProposal(proposal({ kind: 'deal_closed_won', config: { also: [{ kind: 'hubspot_field_changed', config: {} }, { kind: 'nope', config: {} }] } }));
  assert.ok(hs.errors.some(e => /Extra trigger "hubspot_field_changed": .*object and the property/.test(e)));
  assert.ok(hs.errors.some(e => /Extra trigger "nope": .*has no runner/.test(e)));
  assert.equal(validateBuilderProposal(proposal({ kind: 'deal_closed_won', config: { also: 'x' } })).ok, false);
  assert.ok(validateBuilderProposal(proposal({ kind: 'deal_closed_won', signal_keys: ['schedule', 'deal.won'], config: {} })).errors.some(e => /schedule cannot be combined/.test(e)));
});

// A Supabase stand-in: tables filtered by eq/in, every insert recorded; inserts into
// agent_routine_runs are readable afterwards (the dedupe lookup).
function fakeDb(tables) {
  const inserts = [];
  const from = (table) => {
    const filters = [];
    let op = null, payload = null;
    const rows = () => (tables[table] ?? []).filter(r => filters.every(([k, v, inList]) => !(k in r) || (inList ? v.includes(r[k]) : r[k] === v)));
    const q = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res) => res({ data: op ? null : rows(), error: null });
        if (prop === 'maybeSingle' || prop === 'single') return async () => {
          if (op === 'insert') { inserts.push({ table, payload }); (tables[table] ??= []).push({ id: `run-${inserts.length}`, ...payload }); return { data: { id: `run-${inserts.length}` }, error: null }; }
          return { data: op ? null : rows()[0] ?? null, error: null };
        };
        if (prop === 'eq') return (k, v) => { filters.push([k, v]); return q; };
        if (prop === 'in') return (k, v) => { filters.push([k, v, true]); return q; };
        if (['insert', 'update', 'upsert'].includes(prop)) return (p) => { op = prop; payload = p; return q; };
        return () => q;
      },
    });
    return q;
  };
  return { from, inserts };
}

test('deal runner: a won-or-lost job runs for the win and for the loss; a close matching two of a job\'s triggers runs it once', async () => {
  const old = '2025-01-01T00:00:00Z';
  const r = (id, trigger_kind, trigger_config = {}) => ({ id, workspace_id: 'w1', enabled: true, name: id, trigger_kind, trigger_config, steps: [], created_at: old });
  const db = fakeDb({
    agent_routines: [
      r('r_multi', 'deal_closed_won', WON_OR_LOST.trigger_config),
      r('r_won', 'deal_closed_won'),
      // A stage-move job that also starts on wins: a closed deal matches both, one run.
      r('r_stage', 'deal_stage_changed', { also: [{ kind: 'deal_closed_won', config: {} }] }),
      r('r_icp', 'icp_tier_changed'),
    ],
    deal_outcomes: [
      { entity_id: 'a1', outcome: 'won', closed_at: '2026-10-10T00:00:00Z', deal_id: 'd1' },
      { entity_id: 'a2', outcome: 'lost', closed_at: '2026-10-11T00:00:00Z', deal_id: 'd2' },
    ],
    companies: [{ id: 'a1' }, { id: 'a2' }],
    observations: [], agent_routine_runs: [],
  });
  await runAutomationsForWorkspace(db, 'w1', '2026-10-01T00:00:00Z', { max: 50 }).catch(() => {});
  const keys = db.inserts.filter(i => i.table === 'agent_routine_runs').map(i => i.payload.dedupe_key).sort();
  // Per deal for a job that listens to the outcome (GET-881); a close that reaches a job only
  // through its stage-move trigger keys on the account, as stage moves do.
  assert.deepEqual(keys, ['r_multi:deal:d1:closed_won', 'r_multi:deal:d2:closed_lost', 'r_stage:a2:closed_lost', 'r_stage:deal:d1:closed_won', 'r_won:deal:d1:closed_won']);
});

test('HubSpot runner: each watched field of a job (primary or also) is read with its own config', async () => {
  const db = fakeDb({
    agent_routines: [
      { id: 'r1', workspace_id: 'w1', enabled: true, name: 'r1', trigger_kind: 'deal_closed_won', trigger_config: { also: [{ kind: 'hubspot_field_changed', config: { object: 'deals', property: 'amount' } }] } },
      { id: 'r2', workspace_id: 'w1', enabled: true, name: 'r2', trigger_kind: 'hubspot_field_changed', trigger_config: { object: 'companies', property: 'tier', signal_keys: ['hubspot.field_changed'] } },
      { id: 'r3', workspace_id: 'w1', enabled: true, name: 'r3', trigger_kind: 'deal_closed_won', trigger_config: {} },
    ],
  });
  const read = [];
  await processHubspotFieldChanges({ supabase: db, readChanges: async (_sb, ws, cfg) => { read.push(cfg); return { ok: false, reason: 'test' }; } });
  assert.deepEqual(read, [{ object: 'deals', property: 'amount' }, { object: 'companies', property: 'tier' }]);
});
