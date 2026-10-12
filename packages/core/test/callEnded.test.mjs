// "When a call ends" (GET-706): the call reaches the email as {{call.*}}, including the transcript,
// and an automation runs at most once per call, only for the recorders it names.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/callEnded.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templateVarsForTest as templateVars, runCallEndedAutomations, CALL_TRANSCRIPT_CHARS } from '../dist/services/automationRun.mjs';

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
      { id: 'r_gong', name: 'Gong only', trigger_config: { tools: ['gong'] } },
      { id: 'r_done', name: 'Already ran', trigger_config: { tools: ['fireflies'] } },
    ],
    runs: [{ routine_id: 'r_done', dedupe_key: 'r_done:call:m1' }],
  });
  const r = await runCallEndedAutomations(db, 'ws', call);
  assert.equal(r.ran, 0);
  assert.equal(db.log.filter(l => l.insert).length, 0);   // nothing claimed, so nothing was run twice
});
