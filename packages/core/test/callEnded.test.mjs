// "When a call ends" (GET-706): the call reaches the email as {{call.*}}, including the transcript,
// and an automation runs at most once per call, only for the recorders it names.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/callEnded.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templateVarsForTest as templateVars, runCallEndedAutomations, CALL_TRANSCRIPT_CHARS, signalRunKey, signalMoment } from '../dist/services/automationRun.mjs';

const call = {
  meetingId: 'm1', title: 'Acme — pricing review', occurredAt: '2026-10-05T15:00:00Z', source: 'fireflies',
  accountId: 'acc1', attendees: [{ name: 'Sarah Lee', email: 'sarah@acme.example' }, { name: null, email: 'ops@acme.example' }],
  summary: 'They want SSO before signing.', transcript: 'Sarah: we need SSO. '.repeat(10),
};

test('an email can say which call it was, who was on it and what was said', async () => {
  const vars = await templateVars({ steps: [] }, { title: 'Acme — call ended' }, { ctx: { call } });
  assert.equal(vars['call.title'], 'Acme — pricing review');
  assert.equal(vars['call.attendees'], 'Sarah Lee, ops@acme.example');
  assert.equal(vars['call.summary'], 'They want SSO before signing.');
  assert.match(vars['call.transcript'], /^Sarah: we need SSO\./);
  assert.ok(vars['call.date']);
});

test('a long transcript is clipped, not dropped', async () => {
  const vars = await templateVars({ steps: [] }, { title: 'x' }, { ctx: { call: { ...call, transcript: 'a'.repeat(CALL_TRANSCRIPT_CHARS + 500) } } });
  assert.equal(vars['call.transcript'].length, CALL_TRANSCRIPT_CHARS);
});

// A stand-in database: automations to find, runs already claimed, every query recorded.
function fakeDb({ routines = [], runs = [] } = {}) {
  const log = [];
  return {
    log,
    from(table) {
      const filters = {};
      const q = {
        select: () => q, update: () => q, single: () => q, order: () => q, limit: () => q, like: () => q,
        or: (f) => { log.push({ table, or: f }); return q; },
        eq: (k, v) => { filters[k] = v; return q; },
        insert: (row) => { log.push({ table, insert: row }); return q; },
        maybeSingle: async () => {
          if (table === 'agent_routine_runs') return { data: runs.find(r => r.routine_id === filters.routine_id && r.dedupe_key === filters.dedupe_key) ?? null };
          return { data: null };
        },
        then: (ok) => Promise.resolve(table === 'agent_routines' ? { data: routines, error: null } : { data: null, error: null }).then(ok),
      };
      return q;
    },
  };
}

test('no account and no person: nothing runs', async () => {
  const db = fakeDb({ routines: [{ id: 'r1', name: 'Follow-up' }] });
  assert.deepEqual(await runCallEndedAutomations(db, 'ws', { ...call, accountId: null, personId: null }), { ran: 0 });
  assert.equal(db.log.length, 0);
});

test('an automation limited to other recorders does not fire; one already run for this call is skipped', async () => {
  const db = fakeDb({
    routines: [
      { id: 'r_gong', name: 'Gong only', trigger_kind: 'call_ended', trigger_config: { tools: ['gong'] } },
      { id: 'r_done', name: 'Already ran', trigger_kind: 'call_ended', trigger_config: { tools: ['fireflies'] } },
    ],
    runs: [{ routine_id: 'r_done', dedupe_key: 'r_done:call:m1' }],
  });
  const r = await runCallEndedAutomations(db, 'ws', call);
  assert.equal(r.ran, 0);
  assert.equal(db.log.filter(l => l.insert).length, 0);   // nothing claimed, so nothing was run twice
});

// Several signals on one job (GET-873): a call starts a job whose call_ended trigger is one of
// several (trigger_config.also), with that trigger's recorders, and still runs it once.
test('a job that also starts when a call ends runs once for the call; its recorder filter applies', async () => {
  const db = fakeDb({
    routines: [
      { id: 'r_multi', name: 'Won or call', trigger_kind: 'deal_closed_won', trigger_config: { signal_keys: ['deal.won', 'meeting.done:fireflies'], also: [{ kind: 'call_ended', config: { provider: 'fireflies', tools: ['fireflies'] } }] } },
      { id: 'r_twice', name: 'Two recorders', trigger_kind: 'call_ended', trigger_config: { tools: ['granola'], also: [{ kind: 'call_ended', config: { tools: ['fireflies'] } }] } },
      { id: 'r_granola', name: 'Granola only', trigger_kind: 'deal_closed_lost', trigger_config: { also: [{ kind: 'call_ended', config: { tools: ['granola'] } }] } },
      { id: 'r_deal', name: 'Deals only', trigger_kind: 'deal_closed_won', trigger_config: { note: 'call_ended in text only' } },
      { id: 'r_clock', name: 'Clock', trigger_kind: 'clock', trigger_config: { also: [{ kind: 'call_ended', config: {} }] } },
    ],
  });
  await runCallEndedAutomations(db, 'ws', call).catch(() => {});
  // The query asks for the primary kind or the kind inside `also`.
  assert.match(db.log.find(l => l.or).or, /trigger_kind\.eq\.call_ended,trigger_config->>also\.like\.\*call_ended\*/);
  const claimed = db.log.filter(l => l.insert && l.table === 'agent_routine_runs').map(l => l.insert.dedupe_key);
  assert.deepEqual(claimed, ['r_multi:call:m1', 'r_twice:call:m1']);
});

// One conversation, one run (GET-873 review): a job that starts on a call AND on account signals
// would run twice for one call, once on the call and once on the signals read from it. The call's
// run takes the signal path's key for that account and conversation, so whichever comes first runs.
test('a job on calls and on account signals shares one run key per account and conversation', async () => {
  const both = { id: 'r_both', name: 'Call or signal', trigger_kind: 'call_ended', trigger_config: { tools: ['fireflies'], also: [{ kind: 'account_signal', config: { signals: ['churn_risk'] } }] } };
  const callOnly = { id: 'r_call', name: 'Call only', trigger_kind: 'call_ended', trigger_config: { tools: ['fireflies'] } };
  const db = fakeDb({ routines: [both, callOnly] });
  await runCallEndedAutomations(db, 'ws', call).catch(() => {});
  const claimed = db.log.filter(l => l.insert && l.table === 'agent_routine_runs').map(l => l.insert.dedupe_key);
  assert.deepEqual(claimed, [signalRunKey('r_both', 'acc1', 'ref:source://fireflies/m1'), 'r_call:call:m1']);
  // The recording's own source ref wins when the worker passes it.
  const db2 = fakeDb({ routines: [both] });
  await runCallEndedAutomations(db2, 'ws', { ...call, meetingId: 'call-row-1', sourceMeetingId: 'ff-77', sourceRef: 'source://fireflies/ff-77' }).catch(() => {});
  assert.equal(db2.log.find(l => l.insert)?.insert.dedupe_key, signalRunKey('r_both', 'acc1', 'ref:source://fireflies/ff-77'));
});

test('a job that already ran on the signals from this call does not run again on the call', async () => {
  const both = { id: 'r_both', name: 'Call or signal', trigger_kind: 'account_signal', trigger_config: { signals: [], also: [{ kind: 'call_ended', config: {} }] } };
  const db = fakeDb({ routines: [both], runs: [{ routine_id: 'r_both', dedupe_key: signalRunKey('r_both', 'acc1', signalMoment({ source_ref: 'source://fireflies/m1' })) }] });
  const r = await runCallEndedAutomations(db, 'ws', call);
  assert.equal(r.ran, 0);
  assert.equal(db.log.filter(l => l.insert).length, 0);
});
