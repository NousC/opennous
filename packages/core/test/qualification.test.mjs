// MEDDICC beside deal health (GET-1004): what the record knows, letter by letter, never a guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeQualification } from '../dist/services/qualification.mjs';
import { computeDealHealth } from '../dist/services/dealHealth.mjs';

const DAY = 86_400_000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
let n = 0;
const claim = (category, content, metadata = {}, entity_id = 'p-dana') =>
  ({ id: `c${++n}`, source: 'signal_extraction', category, content, metadata, entity_id, created_at: ago(n) });
const people = [
  { id: 'p-dana', name: 'Dana Whitfield', title: 'CTO', seniority: 'c_suite' },
  { id: 'p-priya', name: 'Priya Lund', title: 'Founder & CEO', seniority: 'founder' },
  { id: 'p-abe', name: 'Abe Corr', title: 'Legal Operations', seniority: null },
];
const msg = (contact_id, d) => ({ id: `${contact_id}-${d}`, contact_id, activity_type: 'slack_message', is_outbound: false, occurred_at: ago(d) });
const byKey = (q) => Object.fromEntries(q.items.map(i => [i.key, i]));

test('an empty record knows nothing, and every letter carries its question', () => {
  const q = computeQualification({});
  assert.equal(q.label, 'MEDDICC');
  assert.equal(q.total, 8);
  assert.equal(q.confirmed, 0);
  assert.ok(q.items.every(i => i.status === 'unknown' && i.ask));
});

test('stated facts confirm their letter and cite the claim; a confirmed letter asks nothing', () => {
  const goal = claim('goal', 'Cut lead re-entry from an hour a day to zero');
  const pain = claim('pain', 'Attribution is missing, so they cannot see which source closes');
  const req = claim('requirement', 'Must write back to HubSpot');
  const buyer = claim('authority', 'Priya signs off on tooling spend', { role: 'economic_buyer' }, 'p-priya');
  const champ = claim('authority', 'Dana is pushing this internally', { role: 'champion' });
  const rival = claim('competitor', 'Comparing against Fernpoint', { competitor: 'Fernpoint' });
  const q = byKey(computeQualification({ notes: [goal, pain, req, buyer, champ, rival], stakeholders: people }));
  for (const [k, c] of [['metrics', goal], ['pain', pain], ['decision_criteria', req], ['economic_buyer', buyer], ['champion', champ], ['competition', rival]]) {
    assert.equal(q[k].status, 'confirmed', k);
    assert.deepEqual(q[k].evidence, [c.id], k);
    assert.equal(q[k].ask, null, k);
  }
  assert.match(q.competition.reason, /Fernpoint/);
});

test('pointers are partial, never confirmed: a senior person talking, a likely champion, a lawyer on the deal', () => {
  const activity = [msg('p-dana', 1), msg('p-dana', 2), msg('p-dana', 3), msg('p-priya', 2)];
  const q = byKey(computeQualification({ stakeholders: people, engagedIds: ['p-dana', 'p-priya'], activity,
    notes: [claim('goal', 'Wants reps to stop switching tools')] }));
  assert.equal(q.economic_buyer.status, 'partial');
  assert.equal(q.champion.status, 'partial');
  assert.match(q.champion.reason, /Dana Whitfield/);
  assert.equal(q.paper_process.status, 'partial');
  assert.match(q.paper_process.reason, /Legal Operations/);
  assert.equal(q.metrics.status, 'partial', 'a goal without a number');
  assert.ok(q.economic_buyer.ask && q.champion.ask);
});

test('a senior title nobody is talking to is not a buyer, and a champion who left is not a champion', () => {
  const champ = claim('authority', 'Dana is pushing this internally', { role: 'champion' });
  const left = claim('staff_change', 'Dana left the company', { change: 'left' });
  const q = byKey(computeQualification({ stakeholders: people, engagedIds: [], notes: [champ, left] }));
  assert.equal(q.economic_buyer.status, 'unknown');
  assert.equal(q.champion.status, 'unknown');
});

test('decision process needs two of timeline, approvals and close date; paperwork is confirmed when it came up', () => {
  const timeline = claim('timeline', 'Want it live before the January kickoff');
  const one = byKey(computeQualification({ notes: [timeline] }));
  assert.equal(one.decision_process.status, 'partial');
  const approval = claim('blocker', 'The board has to approve anything over budget', { status: 'open' });
  assert.equal(byKey(computeQualification({ notes: [timeline, approval] })).decision_process.status, 'confirmed');
  assert.equal(byKey(computeQualification({ notes: [timeline], closeDate: '2026-12-01' })).decision_process.status, 'confirmed');
  const paper = claim('blocker', 'Their legal review of the MSA takes two weeks', { status: 'open' });
  assert.equal(byKey(computeQualification({ notes: [paper] })).paper_process.status, 'confirmed');
});

test('deal health carries the qualification beside its score, from the same intel', () => {
  const dh = computeDealHealth({ company: { id: 'co' }, notes: [claim('pain', 'Attribution is missing')], activity: [msg('p-dana', 1)],
    stakeholders: people, nextSteps: [] });
  assert.equal(dh.qualification.total, 8);
  assert.equal(byKey(dh.qualification).pain.status, 'confirmed');
});

test('look-alike words never confirm a letter (review of GET-1004)', () => {
  const q = byKey(computeQualification({ notes: [
    claim('goal', 'Wants to integrate HubSpot with their CRM today'),
    claim('pain', 'Contract renewals are tracked in spreadsheets'),
    claim('requirement', 'Must support email signature capture'),
    claim('objection', 'Still deciding between us and another vendor', { status: 'open' }),
    claim('objection', 'No signs of urgency on their side', { status: 'open' }),
  ] }));
  assert.equal(q.metrics.status, 'partial', 'integrate/today are not numbers');
  assert.equal(q.paper_process.status, 'unknown', 'a pain or a feature that mentions a contract is not the paperwork');
  assert.equal(q.decision_process.status, 'unknown', 'deciding and signs-of are not approval steps');
  const real = byKey(computeQualification({ notes: [claim('goal', 'Cut response time from 2 days to 4 hours'), claim('goal', 'Lift close rate this quarter')] }));
  assert.equal(real.metrics.status, 'confirmed');
});
