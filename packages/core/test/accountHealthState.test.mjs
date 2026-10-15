// Health is a projection over claims, not a stamp (GET-290). The first version let the last call
// overwrite the account: a churn risk raised in March vanished because a training call happened in
// June. Derivation fixes that in both directions — a risk stops counting when nobody repeats it,
// and it survives calls that had nothing to do with it.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/accountHealthState.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveAccountHealth, healthSignalsToSave, HEALTH_CATEGORY, HEALTH_WINDOW_DAYS,
} from '../dist/services/accountHealthState.js';
import { parseHealthReadJson } from '../dist/services/accountHealth.js';

const NOW = new Date('2026-09-16T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const sig = (kind, text, at, quote = '') => ({ kind, text, quote, at, sourceRef: 'source://fellow/x' });

test('one open risk decides the standing, whatever else is on the account', () => {
  const h = deriveAccountHealth([
    sig('risk', 'The sponsor who bought it has left.', daysAgo(10)),
    sig('expansion', 'They asked about a second location.', daysAgo(5)),
  ], NOW);
  // An account with a live churn signal is not "positive" because someone also asked to expand.
  assert.equal(h.standing, 'at_risk');
  assert.equal(h.risks.length, 1);
  assert.equal(h.expansion.length, 1);
});

test('expansion lifts an account that has nothing against it', () => {
  const h = deriveAccountHealth([sig('expansion', 'Asked about the Westgate office.', daysAgo(20))], NOW);
  assert.equal(h.standing, 'positive');
});

test('a risk nobody has repeated goes quiet; the account stops being at risk', () => {
  const stale = deriveAccountHealth([sig('risk', 'Frustrated with onboarding.', daysAgo(200))], NOW);
  assert.equal(stale.standing, 'neutral');
  assert.equal(stale.staleCount, 1);
  assert.equal(stale.risks.length, 0);
  // Said again last week, it counts again — no manual resolving, no stamp to clear.
  const again = deriveAccountHealth([
    sig('risk', 'Frustrated with onboarding.', daysAgo(200)),
    sig('risk', 'Still frustrated with onboarding.', daysAgo(7)),
  ], NOW);
  assert.equal(again.standing, 'at_risk');
});

test('an unrelated later call does not erase an open risk — the stamp bug', () => {
  const h = deriveAccountHealth([
    sig('risk', 'Sponsor left.', daysAgo(60)),
    sig('adoption', 'Two sales reps use the dashboard daily.', daysAgo(2)),
  ], NOW);
  assert.equal(h.standing, 'at_risk', 'a training call in June must not clear March');
  assert.equal(h.lastReadAt, daysAgo(2), 'but the account was still read more recently');
});

test('each kind speaks for its own length of time', () => {
  assert.ok(HEALTH_WINDOW_DAYS.expansion < HEALTH_WINDOW_DAYS.risk, 'an ask goes stale before a risk');
  const h = deriveAccountHealth([sig('expansion', 'Asked about another site.', daysAgo(100))], NOW);
  assert.equal(h.standing, 'neutral', 'a 100-day-old ask is not a live opening');
});

test('drivers explain the standing, newest first', () => {
  const h = deriveAccountHealth([
    sig('risk', 'Older risk.', daysAgo(30), 'we were let down'),
    sig('risk', 'Newer risk.', daysAgo(3), 'we may not renew'),
  ], NOW);
  assert.deepEqual(h.drivers.map(d => d.text), ['Newer risk.', 'Older risk.']);
  assert.equal(h.drivers[0].quote, 'we may not renew');
});

test('a quiet account is neutral with nothing to show, not an error', () => {
  const h = deriveAccountHealth([], NOW);
  assert.equal(h.standing, 'neutral');
  assert.deepEqual(h.drivers, []);
  assert.equal(h.lastReadAt, null);
});

test('a health read becomes ordinary claims, in categories that already exist', () => {
  const health = parseHealthReadJson(JSON.stringify({
    summary: 'A check-in.', what_changed: 'They moved contract sign-off to Finance.',
    adoption: 'Two sales reps daily; Finance has not logged in.', standing: 'at_risk',
    risks: [{ text: 'Sponsor left.', quote: 'Gideon moved on.' }],
    expansion: [{ text: 'Second location?', quote: 'Could we run this at the Westgate office?' }],
    commitments: [{ text: 'Send training link.', quote: "I'll send it Friday." }],
  }));
  const saved = healthSignalsToSave(health, { at: daysAgo(1) });
  assert.deepEqual(saved.map(s => s.category), [HEALTH_CATEGORY.risk, HEALTH_CATEGORY.expansion, HEALTH_CATEGORY.adoption]);
  assert.equal(saved[0].quote, 'Gideon moved on.');
  // Commitments are on the page, not the account: they are what we owe, not what the account IS.
  assert.ok(!saved.some(s => s.content.includes('Send training link')));
});

// ── GET-402: the reader keys on the category ─────────────────────────────────────────────────

test('the category decides the kind; the tag only where the category cannot', async () => {
  const { healthKindOf } = await import('../dist/services/accountHealthState.js');
  // Written by Noema, no tag at all.
  assert.equal(healthKindOf({ category: 'risk_signal', metadata: { severity: 'stated_churn' } }), 'risk');
  assert.equal(healthKindOf({ category: 'expansion_signal', metadata: { stance: 'asked' } }), 'expansion');
  // A decline is a suppression, never an opening — whatever tag a writer left on it.
  assert.equal(healthKindOf({ category: 'expansion_signal', metadata: { stance: 'declined', signal_type: 'health_expansion' } }), null);
  // Adoption: the health read's one-liner counts; an ordinary extracted adoption claim does not.
  assert.equal(healthKindOf({ category: 'adoption', metadata: { signal_type: 'health_adoption' } }), 'adoption');
  assert.equal(healthKindOf({ category: 'adoption', metadata: {} }), null);
  // A pre-GET-401 row in a workspace the backfill has not reached still reads through the tag.
  assert.equal(healthKindOf({ category: 'pain', metadata: { signal_type: 'health_risk' } }), 'risk');
  assert.equal(healthKindOf({ category: 'pain', metadata: {} }), null);
});
