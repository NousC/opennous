// Account signals (GET-686): the kinds the database trigger can write are the kinds every
// surface knows — core labels, the webhook catalog, the editor's picker — and a signal reaches
// the AI step and the email as what fired it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SIGNAL_KINDS, SIGNAL_LABEL, templateVarsForTest as templateVars } from '../dist/services/automationRun.mjs';
import { TRIGGER_EVENTS } from '../dist/db/triggers.js';

const root = new URL('../../../', import.meta.url).pathname;
const sql = readFileSync(`${root}supabase/migrations/2026_10_04_account_signals.sql`, 'utf8');
const kindsInSql = new Set([...sql.slice(sql.indexOf('FUNCTION public.account_signal_kind')).matchAll(/'([a-z]+_[a-z_]+)'/g)]
  .map(m => m[1]).filter(k => SIGNAL_KINDS.includes(k) || /^(objection|competitor|stakeholder|budget|buying|next|expansion|churn)_/.test(k)));

test('every kind the trigger writes has a label, a webhook event and a place in the picker', () => {
  const picker = readFileSync(`${root}apps/frontend/src/lib/automations.ts`, 'utf8');
  for (const k of kindsInSql) {
    assert.ok(SIGNAL_LABEL[k], `label for ${k}`);
    assert.ok(TRIGGER_EVENTS.includes(`signal.${k}`), `webhook event signal.${k}`);
    assert.ok(picker.includes(`["${k}",`), `editor picker offers ${k}`);
  }
  assert.equal(kindsInSql.size, SIGNAL_KINDS.length, `sql kinds ${[...kindsInSql]} vs labels ${SIGNAL_KINDS}`);
});

test('an email can say what fired it', async () => {
  const signal = { kind: 'competitor_evaluating', content: 'They are trialling Acme CRM.', quote: 'We started a trial with Acme last week.', speaker: 'Dana Ortiz' };
  const vars = await templateVars({ steps: [] }, { title: 'Meridian Health — competitor evaluating' }, { stage: 'competitor_evaluating', ctx: { signal } });
  assert.equal(vars['signal.type'], 'Competitor being evaluated');
  assert.equal(vars['signal.text'], 'They are trialling Acme CRM.');
  assert.equal(vars['signal.quote'], 'We started a trial with Acme last week.');
  assert.equal(vars['signal.who'], 'Dana Ortiz');
});

import { processAccountSignals } from '../dist/services/automationRun.mjs';

// A Supabase stand-in for the signal pass: tables answer with fixtures narrowed by eq/is filters,
// and every write is recorded.
function fakeDb(tables) {
  const writes = [];
  const from = (table) => {
    const filters = [];
    let op = null, payload = null;
    const rows = () => (tables[table] ?? []).filter(r => filters.every(([k, v]) => !(k in r) || r[k] === v));
    const q = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          if (op) { writes.push({ table, op, payload, filters: [...filters] }); return (res) => res({ data: null, error: null }); }
          return (res) => res({ data: rows(), error: null });
        }
        if (prop === 'maybeSingle' || prop === 'single') return async () => {
          if (op) writes.push({ table, op, payload, filters: [...filters] });
          return { data: op === 'insert' ? { id: 'run-1' } : rows()[0] ?? null, error: null };
        };
        if (prop === 'eq') return (k, v) => { filters.push([k, v]); return q; };
        if (prop === 'is') return (k, v) => { filters.push([k, v]); return q; };
        if (['insert', 'update', 'upsert'].includes(prop)) return (p) => { op = prop; payload = p; return q; };
        return () => q;
      },
    });
    return q;
  };
  return { from, writes };
}

test('a fresh signal from a call goes to the webhook; private mail and history stay home', async () => {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const sig = (id, prop, occurred_at) => ({
    id, workspace_id: 'w1', entity_id: 'p1', account_id: 'a1', kind: 'objection_raised', claim_property: prop,
    title: 'Pricing', content: 'Too expensive for 12 sites', quote: 'That is above our budget', speaker: 'Dana', source_ref: null,
    detail: { status: 'open' }, occurred_at, processed_at: null,
  });
  const db = fakeDb({
    account_signals: [sig('s-call', 'note.call', now), sig('s-mail', 'note.mail', now), sig('s-old', 'note.old', old)],
    claims: [
      { entity_id: 'p1', property: 'note.call', value: { metadata: { signal_type: 'call_transcript' } }, supporting_observation_ids: [] },
      { entity_id: 'p1', property: 'note.mail', value: { metadata: { signal_type: 'email_thread' } }, supporting_observation_ids: [] },
      { entity_id: 'p1', property: 'note.old', value: { metadata: { signal_type: 'call_transcript' } }, supporting_observation_ids: [] },
    ],
    agent_routines: [],
    trigger_subscriptions: [{ id: 'sub-1', created_at: '2026-01-01T00:00:00Z' }],
    outbound_events: [],
    entity_list_rows: [{ entity_id: 'a1', kind: 'account', name: 'Meridian Health' }],
  });
  const out = await processAccountSignals({ supabase: db });
  assert.equal(out.processed, 3);
  const sent = db.writes.filter(w => w.table === 'outbound_events');
  assert.equal(sent.length, 1, 'only the fresh call signal is sent');
  assert.equal(sent[0].payload[0].event_type, 'signal.objection_raised');
  assert.equal(sent[0].payload[0].payload.data.quote, 'That is above our budget');
  const marked = db.writes.filter(w => w.table === 'account_signals' && w.op === 'update');
  assert.equal(marked.length, 3, 'every signal is marked processed');
  const byId = Object.fromEntries(marked.map(w => [w.filters.find(([k]) => k === 'id')[1], w.payload.team_readable]));
  assert.deepEqual(byId, { 's-call': true, 's-mail': false, 's-old': true });
});

test('five signals from one call start ONE run of a signal automation, not five (GET-834)', async () => {
  const now = new Date().toISOString();
  const kinds = ['next_step', 'buying_signal', 'objection_raised', 'budget_discussed', 'competitor_mentioned'];
  const signals = kinds.map((kind, i) => ({
    id: `s${i}`, workspace_id: 'w1', entity_id: 'p1', account_id: 'a1', kind, claim_property: `note.${i}`,
    title: kind, content: `${kind} said`, quote: null, speaker: 'Dana', source_ref: 'https://notes.example/m/7',
    detail: {}, occurred_at: now, processed_at: null,
  }));
  const db = fakeDb({
    account_signals: signals,
    claims: kinds.map((_, i) => ({ entity_id: 'p1', property: `note.${i}`, value: { metadata: { signal_type: 'call_transcript' } }, supporting_observation_ids: [] })),
    agent_routines: [{ id: 'r1', workspace_id: 'w1', enabled: true, trigger_kind: 'account_signal', name: 'Deal signals', trigger_config: {}, steps: [], created_at: '2026-01-01T00:00:00Z' }],
    agent_routine_runs: [],
    trigger_subscriptions: [],
    outbound_events: [],
    entity_list_rows: [],
  });
  await processAccountSignals({ supabase: db }).catch(() => {});
  const runs = db.writes.filter(w => w.table === 'agent_routine_runs' && w.op === 'insert');
  assert.equal(runs.length, 1, 'one run for the conversation');
  assert.equal(runs[0].payload.dedupe_key, 'r1:signal-moment:a1:ref:https://notes.example/m/7');
});
