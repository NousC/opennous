// Rules (GET-846): the checks behind a checked rule, as pure functions over data the worker loads.
//
// Run: (cd packages/core && npx tsc) && node --test packages/core/test/ruleChecks.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RULE_CHECKS, normalizeCheck, evaluateRule, checkRule, rulePriority,
} from '../dist/services/ruleChecks.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-12T12:00:00Z');
const at = (h) => new Date(NOW + h * HOUR).toISOString();
const rule = (check, params = {}, extra = {}) => ({
  id: 'r1', user_id: 'u1', statement: 's', kind: 'checked', check_type: check, params, weight: 'normal', status: 'active', ...extra,
});

// ── the catalogue ────────────────────────────────────────────────────────────

test('the catalogue names every check with its parameter and default', () => {
  assert.deepEqual(Object.keys(RULE_CHECKS).sort(), ['next_step_after_meeting', 'reply_to_buyer_email', 'stage_without_meeting']);
  for (const c of Object.values(RULE_CHECKS)) {
    assert.ok(c.label && c.param && Number.isFinite(c.default) && c.min > 0 && c.max >= c.default);
  }
});

test('a check is normalized: unknown types are refused, numbers are clamped to the catalogue', () => {
  assert.deepEqual(normalizeCheck('next_step_after_meeting', {}), { check_type: 'next_step_after_meeting', params: { hours: 48 } });
  assert.deepEqual(normalizeCheck('next_step_after_meeting', { hours: 100000 }).params, { hours: RULE_CHECKS.next_step_after_meeting.max });
  assert.deepEqual(normalizeCheck('stage_without_meeting', { days: '10' }).params, { days: 10 });
  assert.equal(normalizeCheck('send_flowers', {}), null);
});

// ── next step after a meeting ────────────────────────────────────────────────

test('a meeting with no dated next step past the window is broken, once per meeting', () => {
  const v = evaluateRule(rule('next_step_after_meeting', { hours: 48 }), {
    meetings: [
      { account_id: 'a1', key: 'm1', at: at(-60), owner_user_id: 'u1', title: 'Pilot review' },
      { account_id: 'a1', key: 'm1', at: at(-60), owner_user_id: 'u1', title: 'Pilot review' },   // a second attendee row
    ],
    tasks: [], bookings: [],
  }, NOW);
  assert.equal(v.length, 1);
  assert.equal(v[0].account_id, 'a1');
  assert.equal(v[0].key, 'next_step_after_meeting:m1');
  assert.equal(v[0].overdue_hours, 12);
  assert.match(v[0].reason, /Pilot review/);
  assert.match(v[0].reason, /48h/);
});

test('a dated task from that meeting, or a meeting booked after it, meets the rule', () => {
  const meetings = [{ account_id: 'a1', key: 'm1', at: at(-60), owner_user_id: 'u1' }];
  const r = rule('next_step_after_meeting', { hours: 48 });
  assert.equal(evaluateRule(r, { meetings, tasks: [{ account_id: 'a1', occurred_at: at(-60), due_at: at(24) }], bookings: [] }, NOW).length, 0);
  assert.equal(evaluateRule(r, { meetings, tasks: [], bookings: [{ account_id: 'a1', at: at(-30) }] }, NOW).length, 0);
  // The held meeting's own booking (dated by its start) is not a next meeting.
  assert.equal(evaluateRule(r, { meetings, tasks: [], bookings: [{ account_id: 'a1', at: at(-60) }] }, NOW).length, 1);
  // An undated task is not a dated next step, and a task from before the meeting does not count.
  assert.equal(evaluateRule(r, { meetings, tasks: [{ account_id: 'a1', occurred_at: at(-60), due_at: null }], bookings: [] }, NOW).length, 1);
  assert.equal(evaluateRule(r, { meetings, tasks: [{ account_id: 'a1', occurred_at: at(-200), due_at: at(24) }], bookings: [] }, NOW).length, 1);
  // A dated task that came in after the window still meets it now: the step exists.
  assert.equal(evaluateRule(r, { meetings, tasks: [{ account_id: 'a1', occurred_at: at(-1), due_at: at(24) }], bookings: [] }, NOW).length, 0);
});

test('inside the window, someone else\'s meeting, or a meeting too old to act on: not broken', () => {
  const r = rule('next_step_after_meeting', { hours: 48 });
  const run = (m) => evaluateRule(r, { meetings: [m], tasks: [], bookings: [] }, NOW).length;
  assert.equal(run({ account_id: 'a1', key: 'm1', at: at(-20), owner_user_id: 'u1' }), 0);
  assert.equal(run({ account_id: 'a1', key: 'm1', at: at(-60), owner_user_id: 'u2' }), 0);
  assert.equal(run({ account_id: 'a1', key: 'm1', at: at(-24 * 30), owner_user_id: 'u1' }), 0);
});

// ── reply to a buyer's email ─────────────────────────────────────────────────

test('a buyer email with no reply past the window is broken; a reply after it meets the rule', () => {
  const r = rule('reply_to_buyer_email', { hours: 24 });
  const inbound = [{ account_id: 'a2', thread_id: 't1', at: at(-30), owner_user_id: 'u1', subject: 'Pricing question' }];
  const v = evaluateRule(r, { inbound, outbound: [] }, NOW);
  assert.equal(v.length, 1);
  assert.equal(v[0].key, 'reply_to_buyer_email:t1');
  assert.equal(v[0].overdue_hours, 6);
  assert.match(v[0].reason, /Pricing question/);
  assert.equal(evaluateRule(r, { inbound, outbound: [{ account_id: 'a2', thread_id: 't1', at: at(-10) }] }, NOW).length, 0);
  // A reply BEFORE the latest buyer message does not answer it.
  assert.equal(evaluateRule(r, { inbound, outbound: [{ account_id: 'a2', thread_id: 't1', at: at(-40) }] }, NOW).length, 1);
  // A reply filed under a teammate's thread id still answers the account.
  assert.equal(evaluateRule(r, { inbound, outbound: [{ account_id: 'a2', thread_id: 'other', at: at(-10) }] }, NOW).length, 0);
});

test('one thread counts from its latest buyer message', () => {
  const r = rule('reply_to_buyer_email', { hours: 24 });
  const inbound = [
    { account_id: 'a2', thread_id: 't1', at: at(-50), owner_user_id: 'u1' },
    { account_id: 'a2', thread_id: 't1', at: at(-5), owner_user_id: 'u1' },
  ];
  assert.equal(evaluateRule(r, { inbound, outbound: [{ account_id: 'a2', thread_id: 't1', at: at(-40) }] }, NOW).length, 0);
});

// ── days in a stage without a meeting ────────────────────────────────────────

test('an open deal in a stage past the window with no meeting since it entered is broken', () => {
  const r = rule('stage_without_meeting', { days: 21 });
  const acct = { account_id: 'a3', name: 'Cobalt', stage: 'proposal', stage_entered_at: at(-24 * 30), last_meeting_at: at(-24 * 40), owner_user_id: 'u1' };
  const v = evaluateRule(r, { accounts: [acct] }, NOW);
  assert.equal(v.length, 1);
  assert.equal(v[0].key, 'stage_without_meeting:a3:proposal');
  assert.equal(v[0].overdue_hours, 9 * 24);
  assert.match(v[0].reason, /proposal/);
  assert.equal(evaluateRule(r, { accounts: [{ ...acct, last_meeting_at: at(-24 * 5) }] }, NOW).length, 0);
  assert.equal(evaluateRule(r, { accounts: [{ ...acct, stage_entered_at: at(-24 * 10) }] }, NOW).length, 0);
  assert.equal(evaluateRule(r, { accounts: [{ ...acct, stage: 'closed_won' }] }, NOW).length, 0);
  assert.equal(evaluateRule(r, { accounts: [{ ...acct, owner_user_id: 'u2' }] }, NOW).length, 0);
});

// ── what does not run, and the priority ──────────────────────────────────────

test('guidance, paused and removed rules are never evaluated', () => {
  const data = { meetings: [{ account_id: 'a1', key: 'm1', at: at(-60), owner_user_id: 'u1' }], tasks: [], bookings: [] };
  assert.equal(evaluateRule(rule(null, {}, { kind: 'guidance' }), data, NOW).length, 0);
  assert.equal(evaluateRule(rule('next_step_after_meeting', { hours: 48 }, { status: 'paused' }), data, NOW).length, 0);
  assert.equal(evaluateRule(rule('next_step_after_meeting', { hours: 48 }, { removed_at: at(-1) }), data, NOW).length, 0);
});

test('priority rises with the weight and with how late it is, and stays an integer', () => {
  assert.ok(rulePriority('high', 1) > rulePriority('normal', 200));
  assert.ok(rulePriority('normal', 1) > rulePriority('low', 200));
  assert.ok(rulePriority('normal', 72) > rulePriority('normal', 1));
  assert.ok(Number.isInteger(rulePriority('normal', 13.5)));
  assert.equal(rulePriority('nonsense', 0), rulePriority('normal', 0));
});

test('met is only what was checked in the window and passes; aged-out instances are neither', () => {
  const r = rule('next_step_after_meeting', { hours: 48 });
  const meetings = [
    { account_id: 'a1', key: 'm1', at: at(-60), owner_user_id: 'u1' },          // met
    { account_id: 'a2', key: 'm2', at: at(-60), owner_user_id: 'u1' },          // broken
    { account_id: 'a3', key: 'm3', at: at(-24 * 30), owner_user_id: 'u1' },     // too old: neither
  ];
  const { broken, met } = checkRule(r, { meetings, tasks: [{ account_id: 'a1', occurred_at: at(-60), due_at: at(24) }], bookings: [] }, NOW);
  assert.deepEqual(broken.map((v) => v.key), ['next_step_after_meeting:m2']);
  assert.deepEqual([...met], ['next_step_after_meeting:m1']);
  assert.equal(checkRule({ ...r, status: 'paused' }, { meetings }, NOW).met.size, 0);
});
