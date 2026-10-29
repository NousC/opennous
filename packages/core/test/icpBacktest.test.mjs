// GET-1074: backtest the ICP score on closed deals. Each deal is scored by its
// best-fitting contact under today's ICP rules (fit only), then graded won/lost.
// Deals with nothing to score on are counted, never scored as a hollow 50.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/icpBacktest.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backtestIcp } from '../dist/icp/icpBacktest.js';

const sig = (key, weight, rule) => ({
  id: key, workspace_id: 'w', key, label: key, weight, rule,
  coverage: 0, added_in: null, active: true, created_at: '', updated_at: '',
});
const RULES = [
  sig('ops_lead', 10, { feature: 'job_title', op: 'contains_any', value: ['head of ops', 'coo'] }),
  sig('software', 8, { feature: 'industry', op: '==', value: 'software' }),
  sig('replied', 15, { feature: 'pipe.replied', op: 'exists' }),          // engagement: not ICP
  sig('reseller', -10, { feature: 'industry', op: '==', value: 'reseller', disqualify: true }),
];
const deal = (id, outcome, contacts) => ({ id, outcome, closedAt: '2024-03-01T00:00:00Z', contacts });

test('a deal is scored by its best-fitting contact', () => {
  const r = backtestIcp([
    deal('d1', 'won', [{ job_title: 'Analyst', industry: 'software' }, { job_title: 'COO', industry: 'software' }]),
  ], RULES);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].score, 90);            // raw 18 → squashed, the COO, not the analyst
  assert.equal(r.rows[0].tier, 'tier_1');
  assert.deepEqual(r.rows[0].fired.sort(), ['ops_lead', 'software']);
});

test('engagement rules never move the backtest score', () => {
  const r = backtestIcp([deal('d1', 'won', [{ industry: 'software', 'pipe.replied': true }])], RULES);
  assert.deepEqual(r.rows[0].fired, ['software']);
});

test('deals with nothing to score are counted per outcome, not scored', () => {
  const r = backtestIcp([
    deal('d1', 'won', [{ job_title: 'COO' }]),
    deal('d2', 'won', []),
    deal('d3', 'lost', [{ email_domain: 'x.test' }]),
  ], RULES);
  assert.deepEqual(r.coverage, { won: { total: 2, scored: 1 }, lost: { total: 1, scored: 0 } });
  assert.deepEqual(r.rows.map(x => x.id), ['d1']);
});

test('an exclusion caps the deal below Not-ICP', () => {
  const r = backtestIcp([deal('d1', 'lost', [{ job_title: 'COO', industry: 'reseller' }])], RULES);
  assert.equal(r.rows[0].tier, 'not_icp');
  assert.ok(r.rows[0].score <= 15);
});

test('lift per rule: how much more often a deal wins when the rule fires', () => {
  const deals = [
    ...Array.from({ length: 6 }, (_, i) => deal(`w${i}`, 'won', [{ job_title: 'COO', industry: i < 2 ? 'software' : 'retail' }])),
    ...Array.from({ length: 2 }, (_, i) => deal(`l${i}`, 'lost', [{ job_title: 'COO', industry: 'retail' }])),
    ...Array.from({ length: 8 }, (_, i) => deal(`m${i}`, 'lost', [{ job_title: 'Analyst', industry: 'retail' }])),
  ];
  const r = backtestIcp(deals, RULES);
  const ops = r.rules.find(x => x.key === 'ops_lead');
  // fires on 8 deals (6 won), not on 8 (0 won): wins where it fires, never where it doesn't.
  assert.deepEqual({ won: ops.fired_won, lost: ops.fired_lost }, { won: 6, lost: 2 });
  assert.deepEqual({ won: ops.not_won, lost: ops.not_lost }, { won: 0, lost: 8 });
  assert.equal(ops.lift, 10);                   // no wins without it: unbounded, reported at the cap
  const sw = r.rules.find(x => x.key === 'software');
  assert.equal(sw.lift, 3.5);                   // 2/2 = 100% vs 4/14 ≈ 28.6%
  assert.equal(r.rules.find(x => x.key === 'replied'), undefined);   // not an ICP rule
});

test('rows carry the shape the score-quality summary reads', () => {
  const r = backtestIcp([deal('d1', 'lost', [{ job_title: 'Analyst', industry: 'software' }])], RULES);
  const row = r.rows[0];
  assert.equal(row.outcome, 'lost');
  assert.equal(row.closedAt, '2024-03-01T00:00:00Z');
  assert.equal(typeof row.score, 'number');
});

// GET-1074 step 2: contact coverage is controlled for, and the page's sections are computed.
const many = (n, prefix, outcome, contacts) => Array.from({ length: n }, (_, i) => deal(`${prefix}${i}`, outcome, contacts));
const coo = (k) => Array.from({ length: k }, (_, i) => (i === 0 ? { job_title: 'COO' } : { job_title: 'Analyst' }));
const analysts = (k) => Array.from({ length: k }, () => ({ job_title: 'Analyst' }));

test('a fit lift that only comes from contact count reads as not validated', () => {
  // Small accounts (1 contact) win 10% whether fit or not; big accounts (8) win 50% either way.
  // Big accounts are mostly fit, so the raw comparison flatters the score.
  const deals = [
    ...many(2, 'sf', 'won', coo(1)), ...many(18, 'sfl', 'lost', coo(1)),
    ...many(4, 'sr', 'won', analysts(1)), ...many(36, 'srl', 'lost', analysts(1)),
    ...many(20, 'bf', 'won', coo(8)), ...many(20, 'bfl', 'lost', coo(8)),
    ...many(2, 'br', 'won', analysts(8)), ...many(2, 'brl', 'lost', analysts(8)),
  ];
  const r = backtestIcp(deals, RULES);
  assert.ok(r.accuracy.raw_ratio > 1.5, `raw ${r.accuracy.raw_ratio}`);
  assert.equal(r.accuracy.controlled_ratio, 1);
  assert.equal(r.accuracy.key, 'not_validated');
  assert.equal(r.accuracy.label, 'Not validated');
  assert.deepEqual(r.accuracy.median_contacts, { won: 8, lost: 1 });
  const big = r.strata.find(s => s.label === '8+ contacts');
  assert.deepEqual([big.fit.rate, big.rest.rate], [0.5, 0.5]);
  assert.equal(r.rules.find(x => x.key === 'ops_lead').impact, 'none');
});

test('a fit lift that holds at equal contacts is validated', () => {
  const deals = [...many(8, 'f', 'won', coo(2)), ...many(12, 'fl', 'lost', coo(2)), ...many(2, 'r', 'won', analysts(2)), ...many(18, 'rl', 'lost', analysts(2))];
  const r = backtestIcp(deals, RULES);
  assert.equal(r.accuracy.controlled_ratio, 4);
  assert.equal(r.accuracy.key, 'validated');
  assert.equal(r.rules.find(x => x.key === 'ops_lead').impact, 'positive');
});

test('too few deals is insufficient data, not a verdict', () => {
  const r = backtestIcp([...many(2, 'f', 'won', coo(1)), ...many(3, 'r', 'lost', analysts(1))], RULES);
  assert.equal(r.accuracy.key, 'insufficient');
});

test('a disqualifier that caps deals winning at the normal rate is flagged for review', () => {
  const reseller = (k) => Array.from({ length: k }, () => ({ job_title: 'Analyst', industry: 'reseller' }));
  const deals = [...many(3, 'x', 'won', reseller(1)), ...many(9, 'xl', 'lost', reseller(1)), ...many(5, 'y', 'won', analysts(1)), ...many(15, 'yl', 'lost', analysts(1))];
  const r = backtestIcp(deals, RULES);
  const d = r.disqualifiers.find(x => x.key === 'reseller');
  assert.deepEqual({ capped: d.capped, won: d.won, status: d.status }, { capped: 12, won: 3, status: 'review' });
  assert.ok(r.recommendations.some(x => x.text === 'Review disqualifier: reseller' && x.meta === '3 won deals capped'));
});

test('data coverage and the research recommendation come from what is on file', () => {
  const r = backtestIcp([...many(10, 'a', 'won', analysts(1)), ...many(10, 'b', 'lost', analysts(1))], RULES);
  assert.deepEqual(r.data_coverage.map(c => [c.label, c.share]), [['Contact job title', 1], ['Industry', 0]]);
  const rec = r.recommendations.find(x => x.text.startsWith('Capture'));
  assert.deepEqual(rec, { text: 'Capture industry in account research', meta: '2 criteria unlocked' });
});

test('a positive-weight criterion that loses more often is flagged to reduce', () => {
  const deals = [...many(2, 'f', 'won', coo(1)), ...many(18, 'fl', 'lost', coo(1)), ...many(10, 'r', 'won', analysts(1)), ...many(10, 'rl', 'lost', analysts(1))];
  const r = backtestIcp(deals, RULES);
  assert.equal(r.rules.find(x => x.key === 'ops_lead').impact, 'negative');
  assert.ok(r.recommendations.some(x => x.text === 'Reduce weight: ops_lead'));
});

// Review fixes: perfect separation is the strongest result, not missing data; a workspace with
// no wins flags no disqualifier.
test('every win inside the ICP reads as validated, not insufficient', () => {
  const deals = [...many(10, 'f', 'won', coo(2)), ...many(10, 'fl', 'lost', coo(2)), ...many(20, 'rl', 'lost', analysts(2))];
  const r = backtestIcp(deals, RULES);
  assert.equal(r.accuracy.controlled_ratio, 10);
  assert.equal(r.accuracy.raw_ratio, 10);
  assert.equal(r.accuracy.key, 'validated');
  assert.equal(r.rules.find(x => x.key === 'ops_lead').impact, 'positive');
});

test('with no wins at all, no disqualifier is flagged for review', () => {
  const reseller = (k) => Array.from({ length: k }, () => ({ job_title: 'Analyst', industry: 'reseller' }));
  const r = backtestIcp([...many(12, 'x', 'lost', reseller(1)), ...many(12, 'y', 'lost', analysts(1))], RULES);
  assert.equal(r.disqualifiers.find(x => x.key === 'reseller').status, 'working');
  assert.ok(!r.recommendations.some(x => x.text.startsWith('Review disqualifier')));
});
