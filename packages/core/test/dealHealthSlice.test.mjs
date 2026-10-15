// One deal's health from its slice of the account, and the one line a list shows beside it.
//
// The stored score is only worth having if it is the number the deal page shows, so the slice is
// pinned here (an open expansion at a customer is not "Won", a roster scopes the facts, a filed
// claim joins the deal), the reason's "last reply" is pinned to the card's own Last Response, and
// the reason line is checked against real computeDealHealth output rather than hand-built signals.
//
// Run: ./packages/core/node_modules/.bin/tsc -p packages/core && node --test packages/core/test/dealHealthSlice.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDealHealth } from '../dist/services/dealHealth.mjs';
import {
  sliceDealHealth, claimFiledToDeal, lastBuyerResponseAt, dealHealthReason,
} from '../dist/services/dealHealthSlice.mjs';

const NOW = Date.now();
const ago = (d) => new Date(NOW - d * 86_400_000).toISOString();
const act = (id, type, daysAgo, contact = 'p1') => ({ id, contact_id: contact, activity_type: type, occurred_at: ago(daysAgo) });
const fact = (id, category, metadata = {}, extra = {}) =>
  ({ id, source: 'signal_extraction', category, metadata, created_at: ago(1), entity_id: 'p1', ...extra });
const cardDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// ── the slice ────────────────────────────────────────────────────────────────

test('claimFiledToDeal reads every place the evidence id has lived', () => {
  const attributed = new Set(['obs-1', 'obs-2']);
  assert.equal(claimFiledToDeal({ supporting_observation_ids: ['obs-9', 'obs-2'], metadata: {} }, attributed), true);
  assert.equal(claimFiledToDeal({ metadata: { source_activity_id: 'obs-1' } }, attributed), true);
  assert.equal(claimFiledToDeal({ metadata: { source_observation_ids: ['obs-2'] } }, attributed), true);
  assert.equal(claimFiledToDeal({ supporting_observation_ids: ['obs-7'], metadata: { source_activity_id: 'obs-8' } }, attributed), false);
  assert.equal(claimFiledToDeal({ supporting_observation_ids: ['obs-1'] }, new Set()), false);
  assert.equal(claimFiledToDeal({ supporting_observation_ids: ['obs-1'] }, undefined), false);
});

test('an open expansion at a paying customer is not "Won", and the account deal still is', () => {
  const acc = {
    company: { id: 'co' },
    contacts: [
      { id: 'p1', job_title: 'General Manager', seniority: 'director', pipeline_stage: 'client', last_activity_at: ago(2) },
      { id: 'p2', job_title: 'BDC Manager', seniority: 'manager', pipeline_stage: 'client', last_activity_at: ago(9) },
    ],
    notes: [],
    activity: [act('w1', 'deal_won', 100), act('r1', 'email_received', 2)],
  };
  const open = sliceDealHealth(acc, { implied: false, status: 'open', roster: ['p1', 'p2'] });
  assert.notEqual(open.health.band, 'Won');
  assert.ok(!open.healthActivity.some(a => a.activity_type === 'deal_won'), 'the account\'s old win is not this deal\'s');
  const implied = sliceDealHealth(acc, { implied: true, status: 'open', roster: [] });
  assert.equal(implied.health.band, 'Won');
});

test('a roster scopes the facts; a claim filed to the deal joins it from off the roster', () => {
  const acc = {
    company: { id: 'co' },
    contacts: [{ id: 'p1' }, { id: 'p3' }],
    notes: [
      fact('n1', 'objection', {}, { entity_id: 'p1' }),
      fact('n2', 'objection', {}, { entity_id: 'p3' }),
      fact('n3', 'competitor', { entity: 'Motorlane CRM' }, { entity_id: 'p3', supporting_observation_ids: ['o9'] }),
    ],
    activity: [act('o9', 'meeting_held', 3, 'p3'), act('o1', 'email_received', 4, 'p1'), act('o2', 'email_received', 5, 'p3')],
  };
  const s = sliceDealHealth(acc, { implied: false, status: 'open', roster: ['p1'] }, new Set(['o9']));
  assert.deepEqual(s.notes.map(n => n.id), ['n1', 'n3']);
  assert.equal(s.notes.find(n => n.id === 'n3').filed_to_deal, true);
  assert.deepEqual(s.people.map(p => p.id), ['p1']);
  // Off-roster activity only when it was filed to the deal.
  assert.deepEqual(s.activity.map(a => a.id).sort(), ['o1', 'o9']);
});

test('a lost deal reads Lost whatever its score', () => {
  const s = sliceDealHealth({ company: { id: 'co' }, contacts: [], notes: [], activity: [] }, { implied: false, status: 'lost', roster: [] });
  assert.equal(s.health.band, 'Lost');
});

// ── the last reply, against the card ────────────────────────────────────────

test('lastBuyerResponseAt is the card\'s Last Response: buyer touches only, past only', () => {
  const activity = [
    act('a1', 'email_received', 12),
    act('a2', 'email_sent', 1),              // ours, not theirs
    act('a3', 'meeting_scheduled', -3),      // next, not last
    act('a4', 'meeting_held', 5),
    act('a5', 'enrichment', 0),
  ];
  const at = lastBuyerResponseAt(activity, NOW);
  assert.equal(Math.round((NOW - Date.parse(at)) / 86_400_000), 5);
  const card = computeDealHealth({ notes: [], activity, stakeholders: [] }).numeric.find(n => n.key === 'last_response');
  assert.equal(card.value, cardDate(at));
});

test('no buyer touch at all is no date, on the card and here', () => {
  const activity = [act('a1', 'email_sent', 3), act('a2', 'linkedin_sent', 4)];
  assert.equal(lastBuyerResponseAt(activity, NOW), null);
  assert.equal(computeDealHealth({ notes: [], activity, stakeholders: [] }).numeric.find(n => n.key === 'last_response').value, '—');
});

// ── the reason line ──────────────────────────────────────────────────────────

const reasonFor = ({ notes = [], activity = [], stakeholders = [] }) => {
  const health = computeDealHealth({ notes, activity, stakeholders });
  return { health, reason: dealHealthReason(health, { notes, lastResponseAt: lastBuyerResponseAt(activity, NOW), now: NOW }) };
};

test('a deal with nothing recorded says so instead of inventing a cause', () => {
  const { health, reason } = reasonFor({});
  assert.ok(health.score < 70);
  assert.equal(reason, 'Nothing recorded on this deal yet: no reply, no stated intent, no objections');
});

test('hard objections outrank silence, and both are named', () => {
  const { health, reason } = reasonFor({
    notes: [
      fact('o1', 'objection', { hardness: 'hard' }),
      fact('o2', 'objection', { hardness: 'hard' }),
      fact('o3', 'objection', { hardness: 'soft' }),
    ],
    activity: [act('r1', 'email_received', 40)],
  });
  assert.equal(health.band, 'At risk');
  assert.equal(reason, '3 open objections, 2 of them hard gates; no reply in 40 days');
});

test('a live competitor is named; a fired one is not', () => {
  const { health, reason } = reasonFor({
    notes: [
      fact('c1', 'competitor', { entity: 'Motorlane CRM', stance: 'evaluating' }),
      fact('c2', 'competitor', { entity: 'Lotwise Suite', stance: 'evaluating' }),
      fact('c3', 'competitor', { entity: 'OldCo', stance: 'past_failure' }),
    ],
    activity: [act('r1', 'email_received', 14)],
    stakeholders: [{ id: 'p1', title: 'VP Sales', seniority: 'vp', signal_count: 1 }],
  });
  assert.ok(health.score < 70);
  assert.equal(reason, 'Competitors in play: Motorlane CRM, Lotwise Suite; single-threaded');
});

test('a healthy deal is explained by what holds it up', () => {
  const { health, reason } = reasonFor({
    notes: [
      fact('b1', 'buying_signal'),
      fact('x1', 'objection', { status: 'resolved' }),
      fact('c1', 'competitor', { entity: 'OldCo', stance: 'past_failure' }),
    ],
    activity: [act('r1', 'email_received', 2), act('m1', 'meeting_held', 3), act('s1', 'email_sent', 4)],
    stakeholders: [
      { id: 'p1', title: 'Managing Director', seniority: 'owner', signal_count: 2 },
      { id: 'p2', title: 'General Manager', seniority: 'director', signal_count: 1 },
    ],
  });
  assert.equal(health.band, 'Healthy');
  assert.equal(reason, 'Active buying intent; buyer replied 2 days ago');
});

test('the line stays one line however long the names are', () => {
  const long = 'An Extraordinarily Long Competitor Name Incorporated Holdings';
  const { reason } = reasonFor({
    notes: [
      fact('c1', 'competitor', { entity: long, stance: 'evaluating' }),
      fact('c2', 'competitor', { entity: `${long} Two`, stance: 'evaluating' }),
    ],
    activity: [act('r1', 'email_received', 400)],
  });
  assert.ok(reason.length <= 140, reason);
  assert.ok(!reason.includes('\n'));
  assert.match(reason, /^Competitors in play: .+…, .+…; no reply in over a year$/);
});

test('won, lost and missing health', () => {
  assert.equal(dealHealthReason({ score: 92, band: 'Won', smart: [], numeric: [] }), 'Won');
  assert.equal(dealHealthReason({ score: 30, band: 'Lost', smart: [], numeric: [] }), 'Lost');
  assert.equal(dealHealthReason(null), null);
  assert.equal(dealHealthReason({ score: null }), null);
});

test('below Healthy with no problem graded, the line says how much is unknown', () => {
  const health = { score: 50, band: 'Needs attention', smart: [], numeric: [], evidence: { graded: 2, total: 4, unknown: ['Competitive Risk', 'Blocker Severity'] } };
  assert.equal(dealHealthReason(health, { lastResponseAt: ago(3), now: NOW }), '2 of 4 signals have nothing recorded yet');
});
