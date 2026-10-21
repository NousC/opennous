// Next step missed and next step slipped (GET-954): an agreed next step is a task, but one whose
// date passed with nothing on the account, or one the buyer keeps pushing, changes what someone
// should do. The rules, against fixtures from the invented world (Harborline, Fernpoint).
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/nextStepSignals.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stepFromClaim, isTouch, missedNextStep, slippedNextSteps, sameStep, MISSED_GRACE_DAYS,
} from '../dist/services/nextStepSignals.mjs';
import { shownAsSignal, SIGNAL_LABEL, TASK_SIGNAL_KINDS } from '../dist/services/signalLabels.mjs';
import { latestSignalView, signalTone } from '../dist/services/signalTone.mjs';
import { TRIGGER_EVENTS, EVENT_CATALOG } from '../dist/db/triggers.js';
import { eventLabel, eventTone } from '../dist/services/eventText.mjs';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const DAY = 86_400_000;
const ago = (d) => new Date(NOW - d * DAY).toISOString();

const claim = (over = {}, value = {}) => ({
  entity_id: 'p-mara', property: 'action_item.meeting_m1_0', valid_from: ago(10), last_observed_at: ago(10),
  value: {
    title: 'Send the security questionnaire by Friday', status: 'open', due_at: ago(5), occurred_at: ago(10),
    source_type: 'meeting', source_id: 'm1', source_url: 'https://notes.example/m1', quote: 'Can you get us the questionnaire by Friday?',
    for_name: 'Mara Quill', due_phrase: 'by Friday', ...value,
  },
  ...over,
});
const step = (over = {}, value = {}) => ({ ...stepFromClaim(claim(over, value)), account_id: 'a-harbor' });

// ── Reading a task claim ───────────────────────────────────────────────────

test('a task claim reads as a step: due date, when it was agreed, where', () => {
  const s = stepFromClaim(claim());
  assert.equal(s.property, 'action_item.meeting_m1_0');
  assert.equal(s.due_at, ago(5));
  assert.equal(s.agreed_at, ago(10));
  assert.equal(s.source_id, 'm1');
  assert.equal(s.status, 'open');
  // Our own rule tasks and internal-meeting tasks are not steps agreed with a buyer.
  assert.equal(stepFromClaim(claim({ property: 'action_item.rule_r1_x' })), null);
  assert.equal(stepFromClaim(claim({ property: 'action_item.internal_slack_c1_0_0' })), null);
  assert.equal(stepFromClaim(claim({ property: 'note.x' })), null);
  // No occurred_at on the value (the email and Fireflies paths): when the claim was first seen.
  assert.equal(stepFromClaim(claim({}, { occurred_at: undefined })).agreed_at, ago(10));
});

test('what counts as a touch: a sent or received message, a call, a meeting; not a bounce or a cancellation', () => {
  for (const p of ['interaction.email_sent', 'interaction.email_received', 'interaction.email_reply', 'interaction.meeting_held',
    'interaction.meeting_scheduled', 'interaction.linkedin_message_sent', 'interaction.call_made', 'interaction.reply']) assert.ok(isTouch(p), p);
  for (const p of ['interaction.meeting_cancelled', 'interaction.email_bounced', 'interaction.unsubscribed',
    'interaction.email_opened', 'interaction.website_visit', 'interaction.linkedin_connection_accepted', 'stage']) assert.equal(isTouch(p), false, p);
});

// ── Missed ─────────────────────────────────────────────────────────────────

test('missed: due five days ago, nothing on the account since it was agreed', () => {
  const s = missedNextStep(step(), [], { now: NOW });
  assert.equal(s.kind, 'next_step_missed');
  assert.equal(s.account_id, 'a-harbor');
  assert.equal(s.entity_id, 'p-mara');
  assert.equal(s.claim_property, 'action_item.meeting_m1_0');
  assert.equal(s.dedupe_key, 'next_step_missed:action_item.meeting_m1_0');
  assert.equal(s.title, 'Send the security questionnaire by Friday');
  assert.equal(s.quote, 'Can you get us the questionnaire by Friday?');
  assert.equal(s.source_ref, 'https://notes.example/m1');
  assert.equal(s.detail.due_at, ago(5));
  assert.equal(s.detail.agreed_at, ago(10));
  // Dated when it became missed (due + the grace day), so the signal pass's freshness reads it right.
  assert.equal(s.occurred_at, new Date(Date.parse(ago(5)) + MISSED_GRACE_DAYS * DAY).toISOString());
  assert.match(s.content, /was due 2026-10-12/);
});

test('done: an email sent after it was agreed and before the deadline', () => {
  assert.equal(missedNextStep(step(), [{ at: ago(6), property: 'interaction.email_sent' }], { now: NOW }), null);
});

test('done: a meeting held on the account counts', () => {
  assert.equal(missedNextStep(step(), [{ at: ago(7), property: 'interaction.meeting_held' }], { now: NOW }), null);
});

test('done: an inbound reply counts too', () => {
  assert.equal(missedNextStep(step(), [{ at: ago(4.5), property: 'interaction.email_received' }], { now: NOW }), null);
});

test('a touch before the step was agreed, or after the deadline, does not fulfil it', () => {
  const touches = [{ at: ago(12), property: 'interaction.email_sent' }, { at: ago(2), property: 'interaction.email_sent' }];
  assert.ok(missedNextStep(step(), touches, { now: NOW }));
});

test('a cancellation or a bounce is not a touch', () => {
  const touches = [{ at: ago(6), property: 'interaction.meeting_cancelled' }, { at: ago(6), property: 'interaction.email_bounced' }];
  assert.ok(missedNextStep(step(), touches, { now: NOW }));
});

test('the one-day grace: due 20 hours ago is not missed yet, due 25 hours ago is', () => {
  assert.equal(missedNextStep(step({}, { due_at: new Date(NOW - 20 * 3_600_000).toISOString() }), [], { now: NOW }), null);
  assert.ok(missedNextStep(step({}, { due_at: new Date(NOW - 25 * 3_600_000).toISOString() }), [], { now: NOW }));
  // A touch inside the grace day still counts as done.
  const due = NOW - 30 * 3_600_000;
  const touch = [{ at: new Date(due + 12 * 3_600_000).toISOString(), property: 'interaction.email_sent' }];
  assert.equal(missedNextStep(step({}, { due_at: new Date(due).toISOString() }), touch, { now: NOW }), null);
});

test('a closed task is done; a step with no due date cannot be missed', () => {
  for (const status of ['done', 'dismissed', 'cancelled', 'closed', 'superseded']) {
    assert.equal(missedNextStep(step({}, { status }), [], { now: NOW }), null, status);
  }
  assert.equal(missedNextStep(step({}, { due_at: null }), [], { now: NOW }), null);
  assert.equal(missedNextStep({ ...step(), account_id: null }, [], { now: NOW }), null, 'no account, no signal');
});

test('history is not news: a step missed weeks ago is not raised now', () => {
  assert.equal(missedNextStep(step({}, { due_at: ago(30), occurred_at: ago(35) }), [], { now: NOW }), null);
  assert.ok(missedNextStep(step({}, { due_at: ago(30), occurred_at: ago(35) }), [], { now: NOW, maxAgeDays: 60 }));
});

test('dedupe: the same step reads to the same key on every pass', () => {
  const a = missedNextStep(step(), [], { now: NOW });
  const b = missedNextStep(step(), [], { now: NOW + 3_600_000 });
  assert.equal(a.dedupe_key, b.dedupe_key);
  assert.equal(a.occurred_at, b.occurred_at, 'dated by the deadline, not by the pass');
});

// ── Slipped ────────────────────────────────────────────────────────────────

// One promise, restated on three calls, each time with a later date.
const first = step({ property: 'action_item.meeting_m1_0' }, { title: 'Send the security questionnaire by Friday', occurred_at: ago(20), due_at: ago(17), source_id: 'm1' });
const second = step({ property: 'action_item.meeting_m2_1' }, { title: 'Send security questionnaire next Wednesday', occurred_at: ago(12), due_at: ago(8), source_id: 'm2', due_phrase: 'next Wednesday' });
const third = step({ property: 'action_item.meeting_m3_0' }, { title: 'Send the security questionnaire within 2 weeks', occurred_at: ago(2), due_at: ago(-10), source_id: 'm3', due_phrase: 'within 2 weeks', quote: 'Let us push the questionnaire again.' });

test('same step: the same promise in other words; another promise is not', () => {
  assert.ok(sameStep(first, second));
  assert.ok(sameStep(first, third));
  assert.equal(sameStep(
    { title: 'Follow up with Ines on the contract' }, { title: 'Follow up with Ines on the invoice' }), false);
  assert.equal(sameStep({ title: 'Book the onboarding call' }, { title: 'Send the security questionnaire' }), false);
});

test('slipped: not on the first push, yes on the second', () => {
  assert.deepEqual(slippedNextSteps([first, second], { now: NOW }), []);
  const [s, ...rest] = slippedNextSteps([first, second, third], { now: NOW });
  assert.equal(rest.length, 0);
  assert.equal(s.kind, 'next_step_slipped');
  assert.equal(s.account_id, 'a-harbor');
  assert.equal(s.claim_property, 'action_item.meeting_m3_0', 'the latest restatement, whose privacy the pass checks');
  assert.equal(s.dedupe_key, 'next_step_slipped:action_item.meeting_m1_0', 'keyed by the first time it was agreed');
  assert.equal(s.occurred_at, ago(2), 'when it was pushed the second time');
  assert.equal(s.quote, 'Let us push the questionnaire again.');
  assert.equal(s.detail.pushes, 2);
  assert.equal(s.detail.first_due_at, ago(17));
  assert.equal(s.detail.previous_due_at, ago(8));
  assert.equal(s.detail.due_at, ago(-10));
  assert.deepEqual(s.detail.steps, ['action_item.meeting_m1_0', 'action_item.meeting_m2_1', 'action_item.meeting_m3_0']);
});

test('slipped: order of the input does not matter, and a third push keeps the same key', () => {
  const fourth = step({ property: 'action_item.meeting_m4_0' }, { title: 'Send the security questionnaire', occurred_at: ago(1), due_at: ago(-20), source_id: 'm4' });
  const a = slippedNextSteps([third, first, second], { now: NOW });
  const b = slippedNextSteps([fourth, third, second, first], { now: NOW });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].dedupe_key, b[0].dedupe_key, 'fires once per next step');
});

test('not a push: the same date restated, an earlier date, a step done in between, or the same call', () => {
  const sameDate = { ...second, due_at: first.due_at };
  assert.deepEqual(slippedNextSteps([first, sameDate, { ...third, due_at: first.due_at }], { now: NOW }), []);
  // Done, then asked for again: a new step, not a push.
  assert.deepEqual(slippedNextSteps([{ ...first, status: 'done' }, second, third], { now: NOW }), []);
  // Two items on one call are two promises, not a push.
  assert.deepEqual(slippedNextSteps([first, { ...second, source_id: 'm1' }, { ...third, source_id: 'm1' }], { now: NOW }), []);
  // Another account's step never chains.
  assert.deepEqual(slippedNextSteps([first, second, { ...third, account_id: 'a-fern' }], { now: NOW }), []);
});

test('slipped: an old chain is history, not news', () => {
  const old = [first, second, third].map((s, i) => ({ ...s, agreed_at: ago(90 - i * 10), due_at: ago(85 - i * 10) }));
  assert.deepEqual(slippedNextSteps(old, { now: NOW }), []);
});

// ── Where it shows ─────────────────────────────────────────────────────────

test('a next step agreed is a task: not a signal a person sees, and not an event (GET-967)', () => {
  assert.deepEqual([...TASK_SIGNAL_KINDS], ['next_step']);
  assert.equal(shownAsSignal('next_step'), false);
  assert.equal(shownAsSignal('next_step_missed'), true);
  assert.equal(shownAsSignal('budget_discussed'), true);
  assert.equal(latestSignalView({ kind: 'next_step', title: 'Send the deck', content: 'Send the deck' }), null);
  assert.equal(TRIGGER_EVENTS.includes('signal.next_step'), false, 'nothing can subscribe to it');
  assert.ok(TRIGGER_EVENTS.includes('signal.next_step_missed'));
});

test('missed and slipped have labels, red and orange tones, and events', () => {
  assert.equal(SIGNAL_LABEL.next_step_missed, 'Next step missed');
  assert.equal(SIGNAL_LABEL.next_step_slipped, 'Next step slipped');
  assert.equal(signalTone('next_step_missed'), 'red');
  assert.equal(signalTone('next_step_slipped'), 'orange');
  const v = latestSignalView({ kind: 'next_step_missed', title: 'Send the deck', content: 'Send the deck was due 2026-10-12.' });
  assert.equal(v.label, 'Next step missed');
  assert.equal(v.tone, 'red');
  for (const k of ['next_step_missed', 'next_step_slipped']) {
    assert.ok(TRIGGER_EVENTS.includes(`signal.${k}`));
    assert.ok(EVENT_CATALOG.some(e => e.type === `signal.${k}` && e.description));
  }
  assert.equal(eventTone('signal.next_step_missed'), 'risk');
  assert.equal(eventTone('signal.next_step_slipped'), 'warning');
  assert.equal(eventLabel('signal.next_step_missed'), 'Next step missed');
  assert.equal(eventLabel('signal.next_step_slipped'), 'Next step slipped');
});

// ── The pass: its reads and its one write ─────────────────────────────────

import { detectNextStepSignalsPoll } from '../dist/services/automationRun.mjs';

// A Supabase stand-in: each table answers with fixtures narrowed by the filters the pass uses, and
// every upsert is recorded.
function fakeDb(tables) {
  const writes = [];
  const from = (table) => {
    const preds = [];
    let upsert = null;
    const rows = () => (tables[table] ?? []).filter(r => preds.every(p => p(r)));
    const get = (r, k) => k.split('->>').reduce((o, x) => (o == null ? o : o[x]), r);
    const q = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          if (upsert) { writes.push({ table, rows: upsert }); return (res) => res({ data: null, error: null }); }
          return (res) => res({ data: rows(), error: null });
        }
        if (prop === 'maybeSingle') return async () => ({ data: rows()[0] ?? null, error: null });
        if (prop === 'upsert') return (p) => { upsert = p; return q; };
        const add = (fn) => (k, v) => { preds.push(r => fn(get(r, k), v)); return q; };
        if (prop === 'eq') return add((a, v) => a === v);
        if (prop === 'neq') return add((a, v) => a !== v);
        if (prop === 'in') return add((a, v) => v.includes(a));
        if (prop === 'is') return add((a, v) => (a ?? null) === v);
        if (prop === 'gte') return add((a, v) => a != null && a >= v);
        if (prop === 'gt') return add((a, v) => a != null && a > v);
        if (prop === 'lt') return add((a, v) => a != null && a < v);
        if (prop === 'lte') return add((a, v) => a != null && a <= v);
        return () => q;   // select, order, range, limit
      },
    });
    return q;
  };
  return { from, writes };
}

const WS = 'w1';
const tables = (touches = []) => ({
  claims: [
    { ...claim(), workspace_id: WS, invalid_at: null, supporting_observation_ids: [] },
    // Someone else's account, due long ago: history, never read.
    { ...claim({ property: 'action_item.meeting_m9_0', entity_id: 'p-old' }, { due_at: ago(40), occurred_at: ago(45) }), workspace_id: WS, invalid_at: null, supporting_observation_ids: [] },
  ],
  entity_list_rows: [
    { workspace_id: WS, entity_id: 'p-mara', kind: 'person', company_id: 'a-harbor' },
    { workspace_id: WS, entity_id: 'a-harbor', kind: 'account', company_id: null },
  ],
  account_signals: [],
  observations: touches.map(t => ({ workspace_id: WS, kind: 'event', entity_id: 'p-mara', value: {}, ...t })),
});

test('the pass writes one missed step into account_signals, keyed once', async () => {
  const db = fakeDb(tables());
  const r = await detectNextStepSignalsPoll({ now: NOW, onlyWorkspace: WS, supabase: db });
  assert.equal(r.written, 1);
  const [w] = db.writes;
  assert.equal(w.table, 'account_signals');
  assert.equal(w.rows.length, 1);
  assert.equal(w.rows[0].workspace_id, WS);
  assert.equal(w.rows[0].kind, 'next_step_missed');
  assert.equal(w.rows[0].account_id, 'a-harbor');
  assert.equal(w.rows[0].dedupe_key, 'next_step_missed:action_item.meeting_m1_0');
});

test('the pass: a meeting with the account before the deadline means it was done', async () => {
  const db = fakeDb(tables([{ property: 'interaction.meeting_held', observed_at: ago(7) }]));
  assert.equal((await detectNextStepSignalsPoll({ now: NOW, onlyWorkspace: WS, supabase: db })).written, 0);
  assert.equal(db.writes.length, 0);
});

test('the pass: a step already raised is not read or written again', async () => {
  const t = tables();
  t.account_signals.push({ workspace_id: WS, kind: 'next_step_missed', dedupe_key: 'next_step_missed:action_item.meeting_m1_0' });
  const db = fakeDb(t);
  assert.equal((await detectNextStepSignalsPoll({ now: NOW, onlyWorkspace: WS, supabase: db })).written, 0);
});
