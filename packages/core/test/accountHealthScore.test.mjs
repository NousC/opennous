// Account health (GET-800): the ACCOUNT page reads the account, not a deal. Five factors —
// engagement trend, decision makers covered, open blockers, risk signals, and adoption for a
// customer — plus the decision-maker list behind the Qualification panel (named and unnamed roles,
// each with a status), the buying-committee rating shared with deal health, and the next step read
// off the latest conversation instead of an old open task.
//
// Run: (cd packages/core && npx tsc) && node --test packages/core/test/accountHealthScore.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decisionMakers, committeeRating, computeAccountHealth, selectNextStep,
} from '../dist/services/accountHealthScore.mjs';
import { computeDealHealth } from '../dist/services/dealHealth.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-08T12:00:00Z');
const iso = (d) => new Date(NOW + d * DAY).toISOString();
let n = 0;
const note = (category, metadata = {}, extra = {}) => ({
  id: `c${++n}`, source: 'signal_extraction', category, metadata, content: `${category} fact`, created_at: iso(-3), ...extra,
});
const act = (type, days, contact_id = 'p1', extra = {}) => ({ id: `o${++n}`, activity_type: type, occurred_at: iso(days), contact_id, ...extra });

const dana = { id: 'p1', name: 'Dana Reyes', title: 'VP Operations', role: null };
const sam = { id: 'p2', name: 'Sam Okafor', title: 'Head of Finance', role: null };

// ── Decision makers ─────────────────────────────────────────────────────────

test('decision makers list named and unnamed roles, each with a status', () => {
  const notes = [
    note('authority', { role: 'decision_maker', quote: 'Dana signs off on tooling' }, { entity_id: 'p1' }),
    note('authority', { role: 'economic_buyer' }, { entity_id: 'p2' }),
    // An unnamed role: the CEO has to approve, nobody has met them.
    note('authority', { role: 'decision_maker', person_title: 'CEO', person_name: null, engagement: 'not_engaged', quote: 'Our CEO has the final say' }, { entity_id: 'acme' }),
  ];
  const activity = [act('email_received', -2, 'p1'), act('email_sent', -40, 'p2')];
  const list = decisionMakers({ notes, stakeholders: [dana, sam], activity, now: NOW });
  assert.equal(list.length, 3);
  const byName = (x) => list.find(d => (d.name ?? d.title) === x);
  assert.equal(byName('Dana Reyes').status, 'engaged');
  assert.equal(byName('Sam Okafor').status, 'not_engaged', 'we wrote, they never replied');
  const ceo = byName('CEO');
  assert.equal(ceo.unnamed, true);
  assert.equal(ceo.name, null);
  assert.equal(ceo.status, 'not_engaged');
  assert.equal(ceo.quote, 'Our CEO has the final say');
  assert.ok(ceo.evidence.length === 1);
});

test('a decision role nobody has ever touched is not contacted; a blocker is blocking', () => {
  const notes = [
    note('authority', { role: 'economic_buyer' }, { entity_id: 'p2' }),
    note('authority', { role: 'blocker' }, { entity_id: 'p1' }),
    note('authority', { role: 'decision_maker', person_title: 'CFO', person_name: null }, { entity_id: 'acme' }),
  ];
  const list = decisionMakers({ notes, stakeholders: [dana, sam], activity: [act('meeting', -1, 'p1')], now: NOW });
  assert.equal(list.find(d => d.entity_id === 'p2').status, 'not_contacted');
  assert.equal(list.find(d => d.entity_id === 'p1').status, 'blocking');
  assert.equal(list.find(d => d.title === 'CFO').status, 'not_contacted');
});

test('an unnamed role whose title a known person holds folds into that person', () => {
  const notes = [note('authority', { role: 'decision_maker', person_title: 'VP Operations', person_name: null }, { entity_id: 'acme' })];
  const list = decisionMakers({ notes, stakeholders: [dana], activity: [act('meeting', -3, 'p1')], now: NOW });
  assert.equal(list.length, 1);
  assert.equal(list[0].entity_id, 'p1');
  assert.equal(list[0].unnamed, false);
  assert.equal(list[0].status, 'engaged');
});

test('a stakeholder already carrying a decision role joins the list without a claim', () => {
  const list = decisionMakers({ notes: [], stakeholders: [{ ...dana, role: 'decision_maker' }, { ...sam, role: 'contact' }], activity: [], now: NOW });
  assert.deepEqual(list.map(d => d.entity_id), ['p1']);
});

// ── Buying committee rating ─────────────────────────────────────────────────

test('one of two decision makers engaged is Moderate, not Strong', () => {
  const r = committeeRating([{ role: 'decision_maker', status: 'engaged' }, { role: 'decision_maker', status: 'not_engaged', unnamed: true }]);
  assert.equal(r.level, 'Moderate');
  assert.equal(r.engaged, 1);
  assert.equal(r.known, 2);
});

test('the committee rating: all engaged is Strong, none Weak, nobody known Unknown; blockers do not count', () => {
  assert.equal(committeeRating([{ role: 'economic_buyer', status: 'engaged' }, { role: 'champion', status: 'engaged' }]).level, 'Strong');
  assert.equal(committeeRating([{ role: 'economic_buyer', status: 'not_contacted' }]).level, 'Weak');
  assert.equal(committeeRating([]).level, 'Unknown');
  assert.equal(committeeRating([{ role: 'blocker', status: 'blocking' }, { role: 'decision_maker', status: 'engaged' }]).level, 'Strong');
});

test('deal health uses the same rating: one of two engaged reads Moderate', () => {
  const notes = [
    note('authority', { role: 'champion' }, { entity_id: 'p2' }),
    note('authority', { role: 'economic_buyer' }, { entity_id: 'p1' }),
  ];
  const h = computeDealHealth({ notes, activity: [{ activity_type: 'meeting', occurred_at: new Date(Date.now() - 2 * DAY).toISOString(), contact_id: 'p1' }], stakeholders: [dana, sam] });
  const c = h.smart.find(s => s.key === 'decision_maker');
  assert.equal(c.level, 'Moderate');
  assert.match(c.reason, /1 of 2/);
});

// ── Account health ──────────────────────────────────────────────────────────

const factor = (h, key) => h.smart.find(f => f.key === key);

test('account health has the four prospect factors and no adoption', () => {
  const h = computeAccountHealth({ notes: [], activity: [act('meeting', -2)], stakeholders: [dana], now: NOW });
  assert.deepEqual(h.smart.map(f => f.key), ['engagement', 'decision_makers', 'blockers', 'risk_signals']);
  assert.equal(h.smart.find(f => f.key === 'adoption'), undefined);
});

// Since GET-804 our own email counts on a conversation (they replied or met with us at some point),
// and never on a cold account.
test('engagement trend reads recent two-way activity, not a cold sequence', () => {
  const rising = computeAccountHealth({ notes: [], activity: [act('meeting', -3), act('email_received', -5), act('email_reply', -10), act('email_received', -45)], stakeholders: [dana], now: NOW });
  assert.equal(factor(rising, 'engagement').level, 'Rising');
  assert.equal(factor(rising, 'engagement').tone, 'good');
  const cold = computeAccountHealth({ notes: [], activity: [act('email_sent', -2), act('email_sent', -4)], stakeholders: [dana], now: NOW });
  assert.equal(factor(cold, 'engagement').tone, 'unknown');
  const quiet = computeAccountHealth({ notes: [], activity: [act('email_received', -40), act('meeting', -45), act('email_sent', -10)], stakeholders: [dana], now: NOW });
  assert.equal(factor(quiet, 'engagement').level, 'Cooling');
  const none = computeAccountHealth({ notes: [], activity: [], stakeholders: [], now: NOW });
  assert.equal(factor(none, 'engagement').tone, 'unknown');
});

test('decision makers covered counts unnamed roles in the denominator', () => {
  const notes = [
    note('authority', { role: 'decision_maker' }, { entity_id: 'p1' }),
    note('authority', { role: 'decision_maker', person_title: 'CEO', person_name: null, engagement: 'not_engaged' }, { entity_id: 'acme' }),
  ];
  const h = computeAccountHealth({ notes, activity: [act('meeting', -2, 'p1')], stakeholders: [dana], now: NOW });
  const f = factor(h, 'decision_makers');
  assert.equal(f.level, 'Moderate');
  assert.equal(f.value, '1/2 engaged');
  assert.equal(f.evidence.length, 2);
  assert.equal(h.decision_makers.length, 2);
});

test('open blockers and risk signals count only what is still open', () => {
  const notes = [
    note('blocker', { status: 'open', quote: 'Legal will not sign until the DPA is done' }),
    note('blocker', { status: 'resolved' }),
    note('risk_signal', {}),
    note('risk_signal', {}),
  ];
  const h = computeAccountHealth({ notes, activity: [act('meeting', -2)], stakeholders: [dana], now: NOW });
  assert.equal(factor(h, 'blockers').value, '1 open');
  assert.equal(factor(h, 'blockers').tone, 'warn');
  assert.equal(factor(h, 'blockers').evidence.length, 1);
  assert.equal(factor(h, 'risk_signals').value, '2 open');
  assert.equal(factor(h, 'risk_signals').tone, 'bad');
  const clear = computeAccountHealth({ notes: [], activity: [act('meeting', -2)], stakeholders: [dana], now: NOW });
  assert.equal(factor(clear, 'blockers').tone, 'good');
});

test('adoption is a factor only for a customer, read from active over total users', () => {
  const h = computeAccountHealth({ notes: [], activity: [act('meeting', -2)], stakeholders: [dana], customer: { activeUsers: 8, totalUsers: 10 }, now: NOW });
  const a = factor(h, 'adoption');
  assert.equal(a.level, 'High');
  assert.equal(a.value, '8/10 active');
  const low = computeAccountHealth({ notes: [], activity: [], stakeholders: [], customer: { activeUsers: 1, totalUsers: 10 }, now: NOW });
  assert.equal(factor(low, 'adoption').tone, 'bad');
});

test('the score blends the factors: a healthy account outscores one at risk', () => {
  const good = computeAccountHealth({
    notes: [note('authority', { role: 'decision_maker' }, { entity_id: 'p1' })],
    activity: [act('meeting', -2, 'p1'), act('email_received', -6, 'p1'), act('email_received', -40, 'p1')],
    stakeholders: [dana], now: NOW,
  });
  const bad = computeAccountHealth({
    notes: [note('blocker', {}), note('blocker', {}), note('risk_signal', {}), note('risk_signal', {}), note('authority', { role: 'decision_maker' }, { entity_id: 'p2' })],
    activity: [act('email_received', -50, 'p2')], stakeholders: [sam], now: NOW,
  });
  assert.ok(good.score >= 70, `good ${good.score}`);
  assert.equal(good.band, 'Healthy');
  assert.ok(bad.score < 40, `bad ${bad.score}`);
  assert.equal(bad.band, 'At risk');
});

// ── Next step ───────────────────────────────────────────────────────────────

test('the follow-up agreed on the latest call beats a month-old open task', () => {
  const call = act('meeting', -2, 'p1', { summary: 'Pilot review' });
  const step = selectNextStep({
    activity: [call, act('email_received', -30)],
    nextSteps: [
      { title: 'Send the pricing sheet', status: 'open', occurred_at: iso(-32), due_at: iso(5) },
      { title: 'Book the stakeholder demo for next Tuesday', status: 'open', occurred_at: call.occurred_at, due_at: iso(4), source_observation_id: call.id },
      { title: 'Share the security questionnaire', status: 'open', occurred_at: call.occurred_at, due_at: null },
    ],
    now: NOW,
  });
  assert.equal(step.status, 'agreed');
  assert.equal(step.title, 'Book the stakeholder demo for next Tuesday');
  assert.equal(step.due_at, iso(4));
  assert.equal(step.conversation.at, call.occurred_at);
  assert.deepEqual(step.items, ['Book the stakeholder demo for next Tuesday', 'Share the security questionnaire']);
});

test('nothing in the last fourteen days: no next step, never a stale task', () => {
  const step = selectNextStep({
    activity: [act('meeting', -25)],
    nextSteps: [{ title: 'Send the pricing sheet', status: 'open', occurred_at: iso(-25), due_at: iso(3) }],
    now: NOW,
  });
  assert.equal(step.status, 'none');
  assert.equal(step.reason, 'No next step agreed in the last two weeks');
  assert.equal(step.title, null);
});

test('a recent call with no follow-up says so, and a booked meeting counts as the next step', () => {
  const none = selectNextStep({ activity: [act('meeting', -3)], nextSteps: [{ title: 'Old task', status: 'open', occurred_at: iso(-40), due_at: null }], now: NOW });
  assert.equal(none.status, 'none');
  assert.equal(none.reason, 'No next step agreed in the last two weeks');
  const booked = selectNextStep({ activity: [act('meeting', -3), act('meeting_scheduled', 6, 'p1', { summary: 'Stakeholder demo' })], nextSteps: [], now: NOW });
  assert.equal(booked.status, 'scheduled');
  assert.equal(booked.title, 'Stakeholder demo');
  assert.equal(booked.due_at, iso(6));
});

test('a meeting whose summary is the whole note is named by its title, or not named at all (GET-827)', () => {
  const note = '# Product Demo and Workspace Updates - Major updates since last call: CRM writeback, task creation\n- Post-call cards (within 5 min of any call): risk flags, next steps, follow-up email draft';
  const titled = act('meeting', -2, 'p1', { description: 'Meeting: Pilot review weekly', summary: note });
  const step = selectNextStep({
    activity: [titled],
    nextSteps: [{ title: 'Push the daily stats into Slack', status: 'open', occurred_at: titled.occurred_at, due_at: null, source_observation_id: titled.id }],
    now: NOW,
  });
  assert.equal(step.conversation.title, 'Pilot review weekly');
  const bare = act('meeting', -2, 'p1', { summary: note });
  const unnamed = selectNextStep({
    activity: [bare],
    nextSteps: [{ title: 'Push the daily stats into Slack', status: 'open', occurred_at: bare.occurred_at, due_at: null, source_observation_id: bare.id }],
    now: NOW,
  });
  assert.equal(unnamed.conversation.title, null);
  const booked = selectNextStep({ activity: [act('meeting_scheduled', 6, 'p1', { summary: note })], nextSteps: [], now: NOW });
  assert.equal(booked.title, 'Meeting booked');
});

test('a call page dated after the last email is the latest conversation', () => {
  const step = selectNextStep({
    activity: [act('email_received', -9)],
    calls: [{ id: 'd1', title: 'Quarterly review', occurred_at: iso(-1) }],
    nextSteps: [{ title: 'Send the renewal draft', status: 'open', occurred_at: iso(-1), due_at: iso(7) }],
    now: NOW,
  });
  assert.equal(step.status, 'agreed');
  assert.equal(step.conversation.kind, 'call');
  assert.equal(step.title, 'Send the renewal draft');
});
