// GET-299: the batch recompute must decide exactly what the per-target path decides.
//
// An import settles its claims in bulk so a report works the moment the import says complete. The
// batch is only safe if it is the same rule — a second derivation of "what is this deal's status"
// is the bug shape this codebase pays for most. These tests pin the batch planner to
// deriveClaim / deriveAuthoritativeClaim on identical observations.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planClaimRecomputes, deriveClaim, deriveAuthoritativeClaim } from '../dist/db/claims.js';
import { isAuthorityAxis } from '../dist/db/canonicalAxes.js';
import { claimNeedsEngineFollowUp, isScoreAffectingProperty, REPORT_CRITICAL_PROPERTIES } from '../dist/services/settleClaimQueue.js';

const DAY = 86400000;
let seq = 0;
const obs = (entity_id, property, value, daysAgo, extra = {}) => ({
  id: `o${++seq}`, entity_id, kind: 'state', property, value, source: 'hubspot', method: 'import',
  source_confidence: 1, observed_at: new Date(Date.now() - daysAgo * DAY).toISOString(),
  ingested_at: new Date().toISOString(), owner_user_id: null, external_id: null, source_ref: null, ...extra,
});
const byKey = (rows) => {
  const m = new Map();
  for (const o of rows) { const k = `${o.entity_id}|${o.property}`; m.set(k, [...(m.get(k) ?? []), o]); }
  return m;
};
// decays_at/freshness depend on Date.now(); compare everything that is decided, not the clock.
const comparable = (d) => d && ({ ...d, confidence: Number(d.confidence.toFixed(6)) });

test('batch writes the same claim the single path derives, per target', () => {
  const rows = [
    obs('deal-1', 'status', 'open', 40), obs('deal-1', 'status', 'lost', 2), obs('deal-1', 'status', 'lost', 5),
    obs('deal-1', 'value', 4788, 3),
    obs('deal-2', 'status', 'won', 1),
    obs('person-1', 'job_title', 'General Manager', 10), obs('person-1', 'job_title', 'Sales Manager', 400),
  ];
  const targets = [
    { entityId: 'deal-1', property: 'status' }, { entityId: 'deal-1', property: 'value' },
    { entityId: 'deal-2', property: 'status' }, { entityId: 'person-1', property: 'job_title' },
  ];
  const planned = planClaimRecomputes(targets, new Map(), byKey(rows), {});
  assert.equal(planned.length, 4);
  for (const p of planned) {
    const mine = rows.filter(o => o.entity_id === p.target.entityId && o.property === p.target.property);
    const single = isAuthorityAxis(p.target.property) ? deriveAuthoritativeClaim(mine, {}) : deriveClaim(mine);
    assert.deepEqual(comparable(p.derived), comparable(single), `${p.target.entityId}/${p.target.property}`);
  }
  assert.equal(planned.find(p => p.target.entityId === 'deal-1' && p.target.property === 'status').derived.value, 'lost');
});

test('one target never reads another target\'s observations', () => {
  const rows = [obs('deal-1', 'status', 'won', 1), obs('deal-2', 'status', 'lost', 1)];
  const [p] = planClaimRecomputes([{ entityId: 'deal-1', property: 'status' }], new Map(), byKey(rows), {});
  assert.equal(p.derived.value, 'won');
  assert.equal(p.derived.observation_count, 1);
});

test('an asserted claim is ground truth and is never overwritten', () => {
  const rows = [obs('deal-1', 'status', 'lost', 1)];
  const existing = new Map([['deal-1|status', { epistemic_class: 'asserted', value: 'won' }]]);
  assert.deepEqual(planClaimRecomputes([{ entityId: 'deal-1', property: 'status' }], existing, byKey(rows), {}), []);
});

test('the previous value is carried so transitions fire only on a real change', () => {
  const rows = [obs('deal-1', 'status', 'lost', 1)];
  const existing = new Map([['deal-1|status', { epistemic_class: 'observed', value: 'open' }]]);
  const [p] = planClaimRecomputes([{ entityId: 'deal-1', property: 'status' }], existing, byKey(rows), {});
  assert.equal(p.before, 'open');
  assert.equal(p.derived.value, 'lost');
});

test('nothing derivable means nothing written', () => {
  assert.deepEqual(planClaimRecomputes([{ entityId: 'deal-9', property: 'status' }], new Map(), new Map(), {}), []);
});

test('reads only the newest 200 observations per target, like getObservations', () => {
  const rows = [];
  for (let i = 0; i < 250; i++) rows.push(obs('deal-1', 'stage', i < 200 ? 'demo' : 'closed', i));
  const [p] = planClaimRecomputes([{ entityId: 'deal-1', property: 'stage' }], new Map(), byKey(rows), {});
  assert.equal(p.derived.observation_count, 200);
  const single = deriveClaim(rows.slice(0, 200));
  assert.deepEqual(comparable(p.derived), comparable(single));
});

test('jobs with engine follow-up stay queued for the engine', () => {
  // Re-scoring and the client-intent flip happen in the engine; settling must not steal them.
  for (const p of ['job_title', 'pipeline_stage', 'industry', 'signal.hiring', 'exclusion.competitor']) {
    assert.equal(claimNeedsEngineFollowUp(p), true, p);
  }
  for (const p of ['status', 'owner_email', 'first_name', 'value', 'lifecycle_stage']) {
    assert.equal(claimNeedsEngineFollowUp(p), false, p);
  }
  assert.equal(isScoreAffectingProperty('job_title'), true);
});

test('report-critical fields include what the reports and org chart read', () => {
  for (const p of ['status', 'value', 'close_date', 'owner_email', 'job_title', 'first_name']) {
    assert.ok(REPORT_CRITICAL_PROPERTIES.includes(p), p);
  }
});

test('a conflict is two genuinely different values from two sources — anything less skips the round trip', async () => {
  const { isFieldConflict } = await import('../dist/db/conflicts.js');
  const c = (value, source) => ({ value, source, observed_at: null, effective: 0.5 });
  assert.equal(isFieldConflict([c('Quillmere Hyundai', 'hubspot')]), false, 'one source, one value');
  assert.equal(isFieldConflict([c('Quillmere Hyundai', 'hubspot'), c('Quillmere Hyundai', 'gmail')]), false, 'sources agree');
  assert.equal(isFieldConflict([c('Quillmere Hyundai', 'hubspot'), c('Ashcombe Volkswagen', 'hubspot')]), false, 'one source changed its mind');
  assert.equal(isFieldConflict([c('Quillmere Hyundai', 'hubspot'), c('Ashcombe Volkswagen', 'fellow')]), true, 'two sources disagree');
});
