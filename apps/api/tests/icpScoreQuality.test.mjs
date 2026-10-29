// GET-1069: how good is the ICP score? One summary, read by the ICP file's learned
// block, the API and the ICP page. Graded only on real won/lost; already-decided and
// no-opportunity are counted as left out, never as outcomes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeScoreQuality, renderIcpBlock } from '../src/lib/icpModel.mjs';

const pred = (score, disposition) => ({ resolved_at: '2026-10-01T00:00:00Z', predicted_value: { score }, outcome_value: { disposition } });
const many = (n, score, disposition) => Array.from({ length: n }, () => pred(score, disposition));

test('conversion per tier, from won and lost only', () => {
  const rows = [
    ...many(8, 85, 'won'), ...many(12, 85, 'lost'),     // Tier 1: 40%
    ...many(2, 30, 'won'), ...many(38, 30, 'lost'),     // Not ICP: 5%
    ...many(50, 90, 'already_decided'), ...many(7, 20, 'no_opportunity'),
    { resolved_at: null, predicted_value: { score: 90 }, outcome_value: null },
  ];
  const q = summarizeScoreQuality(rows);
  assert.deepEqual(q.graded, { won: 10, lost: 50 });
  assert.deepEqual(q.left_out, { already_decided: 50, no_opportunity: 7 });
  const t1 = q.tiers.find(t => t.tier === 'tier_1');
  const no = q.tiers.find(t => t.tier === 'not_icp');
  assert.equal(t1.won, 8); assert.equal(t1.lost, 12); assert.equal(t1.rate, 0.4);
  assert.equal(no.rate, 0.05);
  assert.equal(q.verdict.key, 'separates');
});

test('few outcomes: says the score is still the ICP', () => {
  const q = summarizeScoreQuality([...many(2, 85, 'won'), ...many(3, 30, 'lost')]);
  assert.equal(q.verdict.key, 'learning');
  assert.match(q.verdict.text, /still your ICP/);
});

test('fit accounts converting no better reads as not predictive', () => {
  const q = summarizeScoreQuality([...many(5, 85, 'won'), ...many(45, 85, 'lost'), ...many(10, 30, 'won'), ...many(40, 30, 'lost')]);
  assert.equal(q.verdict.key, 'not_predictive');
});

test('the ICP file block carries the summary', () => {
  const rows = [...many(8, 85, 'won'), ...many(12, 85, 'lost'), ...many(2, 30, 'won'), ...many(38, 30, 'lost'), ...many(50, 90, 'already_decided')];
  const model = {
    has_model: true, has_outcomes: true,
    signals: [{ key: 'b2b', label: 'B2B software', weight: 6, fires: 20, lift: 2.1 }],
    calibration: { gap: 0.3, resolved: 60, won: 10, lost: 50 },
    quality: summarizeScoreQuality(rows),
  };
  const block = renderIcpBlock(model, { syncedAt: '2026-10-29T00:00:00Z' });
  assert.match(block, /How good is this score/);
  assert.match(block, /Graded on 10 won \/ 50 lost/);
  assert.match(block, /50 left out: already customers or already lost when scored/);
  assert.match(block, /Tier 1 converted 40%/);
  assert.match(block, /Not ICP 5%/);
});

// GET-1070: the block reads trust first, then the drivers as a table.
test('the ICP file block: quality first, drivers as a table, no calibration line', () => {
  const rows = [...many(8, 85, 'won'), ...many(12, 85, 'lost'), ...many(2, 30, 'won'), ...many(38, 30, 'lost')];
  const block = renderIcpBlock({
    has_model: true, has_outcomes: true,
    signals: [
      { key: 'b2b', label: 'B2B software', weight: 6, fires: 20, lift: 2.1 },
      { key: 'tiny', label: 'Under 10 staff | solo', weight: -4, fires: 9, lift: 0.4 },
      { key: 'new', label: 'Runs outbound', weight: 3, fires: 0, lift: null },
      { key: 'cc', label: 'Cold-calling agency', weight: -10, rule: { disqualify: true, feature: 'exclusion.cold_calling' } },
    ],
    calibration: { gap: 0.3, resolved: 60, won: 10, lost: 50 },
    quality: summarizeScoreQuality(rows),
  }, { syncedAt: '2026-10-29T00:00:00Z' });
  const at = (re) => block.search(re);
  assert.ok(at(/How good is this score/) < at(/\| Win drivers/), 'quality comes before the drivers');
  assert.ok(at(/\| Win drivers/) < at(/Not a fit/) && at(/Not a fit/) < at(/\| Loss drivers/));
  assert.match(block, /\| Win drivers \| Weight \| Lift \| n \|\n\|---\|---:\|---:\|---:\|/);
  assert.match(block, /\| B2B software \| \+6 \| 2\.1x \| 20 \|/);
  assert.match(block, /\| Runs outbound \| \+3 \| – \| – \|/);
  assert.match(block, /\| Under 10 staff \\\| solo \| -4 \| 0\.4x \| 9 \|/);
  assert.match(block, /- Cold-calling agency {2}`exclusion\.cold_calling`/);
  assert.match(block, /For agents: route on the tier/);
  assert.doesNotMatch(block, /Calibration gap/);
});

test('agents are told to treat a learning or weak score as a hint', () => {
  const learning = renderIcpBlock({ has_model: true, has_outcomes: true, signals: [{ key: 'b2b', label: 'B2B', weight: 6 }],
    calibration: { gap: null, won: 2, lost: 3 }, quality: summarizeScoreQuality([...many(2, 85, 'won'), ...many(3, 30, 'lost')]) });
  assert.match(learning, /For agents: .*hint/);
  assert.doesNotMatch(learning, /route on the tier/);
});

test('without a quality summary the calibration gap is still shown', () => {
  const block = renderIcpBlock({ has_model: true, has_outcomes: true, signals: [{ key: 'b2b', label: 'B2B', weight: 6, lift: 2, fires: 4 }],
    calibration: { gap: 0.3, won: 3, lost: 2 } });
  assert.match(block, /Calibration gap \+0\.3/);
});
