// Why it closed, as a dated path (GET-405). Run: node --test packages/core/test/dealCloseRecord.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCloseRecord, pathPrefixMatch, QUIET_DAYS } from '../dist/services/dealCloseRecord.js';

const d = (s) => `2026-${s}T12:00:00.000Z`;
const base = { openedAt: d('06-01'), closedAt: d('08-14'), touches: [], closeDateChanges: [] };

test('a lost deal reads as the path the reviewer sketched, in the order it happened', () => {
  const r = buildCloseRecord({
    ...base, outcome: 'lost', repReason: 'Budget',
    claims: [
      { id: 'c3', category: 'objection', content: 'Routewell is cheaper', quote: "Routewell is cheaper and covers what we need", at: d('07-03'), status: 'open', hardness: 'hard', filedToDeal: true },
      { id: 'c4', category: 'competitor', content: 'Uses Routewell', at: d('07-10'), stance: 'incumbent', entity: 'Routewell' },
      { id: 'c1', category: 'authority', content: 'Sales associate', at: d('06-02'), role: 'technical' },
    ],
    touches: [d('06-05'), d('07-10'), d('07-22')],
    closeDateChanges: [{ at: d('06-01'), value: d('06-30') }, { at: d('06-19'), value: d('08-15') }],
  });
  assert.deepEqual(r.path, ['no_decision_maker', 'close_date_slipped', 'objection_open', 'competitor_named', 'went_quiet']);
  assert.equal(r.explained, true);
  assert.equal(r.rep_reason, 'Budget');
  const obj = r.events.find(e => e.kind === 'objection_open');
  assert.equal(obj.claim_id, 'c3');
  assert.equal(obj.attribution, 'deal', 'a claim whose conversation was filed to the deal says so');
  assert.equal(r.events.find(e => e.kind === 'competitor_named').attribution, 'roster');
  assert.equal(r.events.find(e => e.kind === 'went_quiet').detail.days, 23);
});

test('a lost deal with nothing on record is unexplained, never assigned the popular cause', () => {
  const r = buildCloseRecord({ ...base, outcome: 'lost', claims: [{ id: 'a', category: 'authority', content: 'CFO', at: d('06-02'), role: 'economic_buyer' }], touches: [d('08-10')] });
  assert.deepEqual(r.path, []);
  assert.equal(r.explained, false);
});

test('what was said after the close is not why it closed', () => {
  const r = buildCloseRecord({ ...base, outcome: 'lost', claims: [
    { id: 'late', category: 'objection', content: 'Too expensive', at: d('09-20'), status: 'open' },
    { id: 'a', category: 'authority', content: 'CFO', at: d('06-02'), role: 'economic_buyer' },
  ], touches: [d('08-10')] });
  assert.deepEqual(r.path, []);
});

test('a past failure is an opening, not a cause; a handled objection is not open', () => {
  const r = buildCloseRecord({ ...base, outcome: 'lost', claims: [
    { id: 'a', category: 'authority', content: 'CFO', at: d('06-02'), role: 'economic_buyer' },
    { id: 'x', category: 'competitor', content: 'Fired Gong', at: d('06-10'), stance: 'past_failure', entity: 'Gong' },
    { id: 'y', category: 'objection', content: 'Security review', at: d('06-12'), status: 'addressed' },
  ], touches: [d('08-10')] });
  assert.deepEqual(r.path, []);
});

test('no claims read means no "no buyer" event: absence of evidence is not evidence', () => {
  // Every deal on the first dry run, on deals whose conversations were never extracted.
  const r = buildCloseRecord({ ...base, outcome: 'lost', claims: [], touches: [d('08-10')] });
  assert.deepEqual(r.path, []);
  assert.equal(r.explained, false);
  // One claim of any kind read, and still no buyer → the event stands.
  const r2 = buildCloseRecord({ ...base, outcome: 'lost', claims: [{ id: 'p', category: 'pain', content: 'slow', at: d('06-10') }], touches: [d('08-10')] });
  assert.deepEqual(r2.path, ['no_decision_maker']);
  assert.equal(r2.events[0].detail.claims_read, 1);
});

test('a same-day change is not a slip, and the change on the close day is the close', () => {
  const claims = [{ id: 'a', category: 'authority', content: 'CFO', at: d('06-02'), role: 'economic_buyer' }];
  const sameDay = buildCloseRecord({ ...base, outcome: 'lost', claims, touches: [d('08-10')],
    closeDateChanges: [{ at: d('06-01'), value: '2026-09-07T00:00:00.000Z' }, { at: d('06-19'), value: '2026-09-07T04:00:00.000Z' }] });
  assert.deepEqual(sameDay.path, []);
  const onClose = buildCloseRecord({ ...base, outcome: 'lost', claims, touches: [d('08-10')],
    closeDateChanges: [{ at: d('06-01'), value: d('09-07') }, { at: d('08-14'), value: d('08-14') }] });
  assert.deepEqual(onClose.path, [], 'the CRM stamping the actual close date is not a slip');
  const real = buildCloseRecord({ ...base, outcome: 'lost', claims, touches: [d('08-10')],
    closeDateChanges: [{ at: d('06-01'), value: d('06-30') }, { at: d('06-19'), value: d('08-15') }] });
  assert.deepEqual(real.path, ['close_date_slipped']);
});

test('a close date moving EARLIER is not a slip', () => {
  const r = buildCloseRecord({ ...base, outcome: 'no_decision', claims: [{ id: 'a', category: 'authority', content: 'CFO', at: d('06-02'), role: 'economic_buyer' }], touches: [d('08-10')],
    closeDateChanges: [{ at: d('06-01'), value: d('08-30') }, { at: d('06-19'), value: d('07-15') }] });
  assert.deepEqual(r.path, []);
});

test('a won deal reads as champion → objection resolved → buying signal', () => {
  const r = buildCloseRecord({ ...base, outcome: 'won', claims: [
    { id: 'b', category: 'buying_signal', content: 'Asked for the agreement', quote: 'send the agreement', at: d('07-30') },
    { id: 'o', category: 'objection', content: 'Security', at: d('06-20'), status: 'resolved' },
    { id: 'ch', category: 'authority', content: 'Pushing internally', at: d('06-05'), role: 'champion' },
    { id: 'r', category: 'risk_signal', content: 'ignored on a win', at: d('06-06'), severity: 'friction' },
  ] });
  assert.deepEqual(r.path, ['champion', 'objection_resolved', 'buying_signal']);
  assert.equal(r.explained, true);
});

test('silence is measured on real touches, on the quiet bar', () => {
  const r = buildCloseRecord({ ...base, outcome: 'lost', claims: [{ id: 'a', category: 'authority', content: 'CFO', at: d('06-02'), role: 'economic_buyer' }],
    touches: [d('08-14')] });
  assert.equal(r.events.some(e => e.kind === 'went_quiet'), false);
  const q = buildCloseRecord({ ...base, outcome: 'lost', claims: [{ id: 'a', category: 'authority', content: 'CFO', at: d('06-02'), role: 'economic_buyer' }],
    touches: [new Date(Date.parse(d('08-14')) - QUIET_DAYS * 86400000).toISOString()] });
  assert.equal(q.events.some(e => e.kind === 'went_quiet'), true);
});

test('an open deal on the first steps of a lost path is a prefix match', () => {
  const pattern = ['no_decision_maker', 'close_date_slipped', 'objection_open', 'competitor_named', 'went_quiet'];
  assert.equal(pathPrefixMatch(['no_decision_maker', 'close_date_slipped', 'objection_open'], pattern), 3);
  assert.equal(pathPrefixMatch(['objection_open'], pattern), 0, 'order matters: a later step alone is not the path');
  assert.equal(pathPrefixMatch(['no_decision_maker', 'budget_constraint', 'close_date_slipped'], pattern), 2, 'other events in between do not break it');
});

// ── the aggregate ────────────────────────────────────────────────────────────────────────────
import { summarizeClosePaths } from '../dist/services/dealCloseRecord.js';

test('a path shared by a third of losses and none of the wins ranks first, with both rates', () => {
  const L = (path) => ({ outcome: 'lost', path });
  const W = (path) => ({ outcome: 'won', path });
  const s = summarizeClosePaths([
    L(['no_decision_maker', 'objection_open', 'competitor_named', 'went_quiet']),
    L(['objection_open', 'competitor_named', 'went_quiet']),
    L(['close_date_slipped', 'objection_open', 'competitor_named']),
    L(['went_quiet']), L(['budget_constraint']), L([]),
    W(['champion', 'buying_signal']), W(['objection_resolved', 'buying_signal']), W(['buying_signal']),
  ], { minLost: 3 });
  assert.equal(s.lost_n, 6); assert.equal(s.won_n, 3);
  assert.equal(s.lost_explained_pct, 83.3);
  assert.deepEqual(s.patterns[0].steps, ['objection_open', 'competitor_named']);
  assert.equal(s.patterns[0].lost_n, 3); assert.equal(s.patterns[0].lost_pct, 50);
  assert.equal(s.patterns[0].won_n, 0); assert.equal(s.patterns[0].won_pct, 0);
  assert.equal(s.patterns[0].lift, 50);
});

test('a pattern wins share too is not a loss pattern: lift says so', () => {
  const rows = [
    ...Array.from({ length: 4 }, () => ({ outcome: 'lost', path: ['objection_open', 'went_quiet'] })),
    ...Array.from({ length: 4 }, () => ({ outcome: 'won', path: ['objection_open', 'went_quiet'] })),
  ];
  const s = summarizeClosePaths(rows, { minLost: 3 });
  assert.equal(s.patterns[0].lift, 0);
});

test('subsequences, not exact paths: events in between do not break a pattern', () => {
  const s = summarizeClosePaths([
    { outcome: 'lost', path: ['objection_open', 'budget_constraint', 'went_quiet'] },
    { outcome: 'lost', path: ['objection_open', 'went_quiet'] },
    { outcome: 'lost', path: ['objection_open', 'competitor_named', 'timing_constraint', 'went_quiet'] },
  ], { minLost: 3 });
  assert.ok(s.patterns.some(p => p.steps.join('>') === 'objection_open>went_quiet' && p.lost_n === 3));
});
