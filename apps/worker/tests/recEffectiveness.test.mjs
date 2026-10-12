// The closed loop's ranking policy. scoreRec turns learned per-category conversion into
// the priority the matcher writes onto each rec (and the decision to suppress). These lock
// the honest-at-small-N discipline (thin data never moves the worklist), the clamp bounds,
// and the decisive-underperformance suppression rule. loadEffectiveness's unpacking of the
// learned observation is checked against a stubbed read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRec, loadEffectiveness } from '../src/intelligence/effectiveness.mjs';

// An effectiveness lookup like loadEffectiveness returns. overall = 0.20.
const eff = {
  hasData: true,
  overallRate: 0.2,
  total: 100,
  byCategory: new Map([
    ['leakage', { acted: 40, converted: 16, rate: 0.4 }],   // 2x overall -> boosted, capped at 2.0
    ['hygiene', { acted: 30, converted: 3, rate: 0.1 }],    // 0.5x overall -> halved
    ['journey', { acted: 20, converted: 1, rate: 0.05 }],   // 0.25x, strong sample -> suppressed
    ['meeting', { acted: 4, converted: 3, rate: 0.75 }],    // great rate but THIN (n<8) -> neutral
  ]),
  byChannel: new Map([
    ['linkedin', { acted: 50, converted: 5, rate: 0.1 }],
  ]),
};

test('no learned data yet → everything neutral (priority 1, no suppress)', () => {
  const r = scoreRec({ category: 'leakage' }, { hasData: false });
  assert.equal(r.priority, 1);
  assert.equal(r.suppress, false);
  assert.equal(r.effectiveness.applied, false);
});

test('a category converting above overall is boosted, clamped at 2.0', () => {
  const r = scoreRec({ category: 'leakage' }, eff);
  assert.equal(r.priority, 2);          // 0.4/0.2 = 2.0, at the cap
  assert.equal(r.suppress, false);
  assert.equal(r.effectiveness.applied, true);
  assert.equal(r.effectiveness.category_rate, 0.4);
});

test('a category converting below overall is down-ranked', () => {
  const r = scoreRec({ category: 'hygiene' }, eff);
  assert.equal(r.priority, 0.5);        // 0.1/0.2 = 0.5
  assert.equal(r.suppress, false);
});

test('decisive underperformance on strong sample is suppressed, not just down-ranked', () => {
  const r = scoreRec({ category: 'journey' }, eff);
  assert.equal(r.suppress, true);       // 0.05 ≤ 0.2*0.35 and acted(20) ≥ 16
  assert.equal(r.effectiveness.suppressed, true);
});

test('a thin category sample (n<8) never moves the worklist', () => {
  const r = scoreRec({ category: 'meeting' }, eff);   // 0.75 rate but only 4 acted
  assert.equal(r.priority, 1);
  assert.equal(r.suppress, false);
  assert.equal(r.effectiveness.applied, false);
});

test('an unknown category is neutral', () => {
  const r = scoreRec({ category: 'nope' }, eff);
  assert.equal(r.priority, 1);
  assert.equal(r.suppress, false);
});

test('category and channel signals compound, then clamp', () => {
  // leakage 2x * linkedin 0.5x = 1.0
  const r = scoreRec({ category: 'leakage', channel: 'linkedin' }, eff);
  assert.equal(r.priority, 1);
  assert.equal(r.effectiveness.channel_rate, 0.1);
});

test('loadEffectiveness unpacks the learned observation and gates on overall sample', async () => {
  const evidence = {
    total: 12, overall_rate: 0.25,
    by_category: [{ key: 'leakage', acted: 12, converted: 3, rate: 0.25 }],
    by_channel: [{ key: 'email', acted: 12, converted: 3, rate: 0.25 }],
  };
  const supabase = stubObs({ sample_size: 12, effect: 0.25, evidence });
  const out = await loadEffectiveness(supabase, 'ws1');
  assert.equal(out.hasData, true);
  assert.equal(out.overallRate, 0.25);
  assert.equal(out.byCategory.get('leakage').acted, 12);
  assert.equal(out.byChannel.get('email').rate, 0.25);
});

test('loadEffectiveness reports no data below the overall sample floor', async () => {
  const supabase = stubObs({ sample_size: 3, effect: 0.3, evidence: { total: 3, overall_rate: 0.3 } });
  const out = await loadEffectiveness(supabase, 'ws1');
  assert.equal(out.hasData, false);     // total 3 < MIN_SAMPLE(8)
});

test('loadEffectiveness is safe when no observation exists yet', async () => {
  const out = await loadEffectiveness(stubObs(null), 'ws1');
  assert.equal(out.hasData, false);
  assert.equal(out.byCategory.size, 0);
});

// Minimal chainable Supabase stub for a single .from().select().eq().eq().maybeSingle().
function stubObs(row) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return { from: () => chain };
}
