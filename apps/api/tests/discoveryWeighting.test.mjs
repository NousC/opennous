import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverSignals } from '@nous/core';

// Recency decay + volume-weighted confidence in contrastive discovery (pure).
// Cohorts use ONE boolean feature (has_api) on the winners; every other row
// carries a unique filler so no competing candidate forms — discoverSignals
// then returns exactly the has_api signal, whose weight we inspect.

let _u = 0;
const filler = () => ({ [`u${_u++}`]: true });

function build({ nWith, nOtherWin, nLoss, atWith = null, atOther = null }) {
  const eps = [];
  for (let i = 0; i < nWith; i++) eps.push({ features: { has_api: true }, disposition: 'won', at: atWith });
  for (let i = 0; i < nOtherWin; i++) eps.push({ features: filler(), disposition: 'won', at: atOther });
  for (let i = 0; i < nLoss; i++) eps.push({ features: filler(), disposition: 'lost', at: atOther });
  return eps;
}
const apiWeight = (eps) => discoverSignals(eps, []).find(s => s.signal.rule.feature === 'has_api')?.signal.weight ?? 0;

test('volume: a signal backed by more deals earns more weight than the same lift on fewer', () => {
  const wFew = apiWeight(build({ nWith: 4, nOtherWin: 1, nLoss: 5 }));   // 10 deals
  const wMany = apiWeight(build({ nWith: 16, nOtherWin: 4, nLoss: 20 })); // 40 deals, same lift
  assert.ok(wFew > 0 && wMany > 0, `both produce a positive signal (${wFew}, ${wMany})`);
  assert.ok(wMany > wFew, `more deals → sturdier weight (${wMany} > ${wFew})`);
});

test('recency: recent wins for a feature beat the same feature won long ago', () => {
  const recentISO = '2026-06-01T00:00:00Z';
  const oldISO = '2024-06-01T00:00:00Z'; // ~2 years → heavily decayed
  // Both cohorts share the same recent "other" rows (anchor newest = recent);
  // only the has_api wins differ in age.
  const wRecent = apiWeight(build({ nWith: 6, nOtherWin: 2, nLoss: 6, atWith: recentISO, atOther: recentISO }));
  const wOld = apiWeight(build({ nWith: 6, nOtherWin: 2, nLoss: 6, atWith: oldISO, atOther: recentISO }));
  assert.ok(wRecent > 0, `recent wins produce a signal (${wRecent})`);
  assert.ok(wRecent > wOld, `recent evidence outweighs aged evidence (${wRecent} > ${wOld})`);
});

test('no timestamps → equal-weight discovery still works', () => {
  const w = apiWeight(build({ nWith: 10, nOtherWin: 2, nLoss: 12 }));
  assert.ok(w > 0, `equal-weight discovery still finds the signal (${w})`);
});
