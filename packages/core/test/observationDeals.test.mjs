// Activity → deal attribution rows. Pure shape tests; the write is an idempotent upsert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observationDealRows } from '../dist/db/observationDeals.js';

const WS = 'ws-1', OBS = 'obs-1';

test('crm source: one row per deal, confidence 1, no decided_by', () => {
  const rows = observationDealRows(WS, OBS, ['dealA', 'dealB'], 'crm');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.deal_entity_id), ['dealA', 'dealB']);
  for (const r of rows) {
    assert.equal(r.source, 'crm');
    assert.equal(r.confidence, 1);
    assert.equal(r.decided_by, null);
    assert.equal(r.observation_id, OBS);
  }
});

test('human source: confidence is always 1 and decided_by is kept', () => {
  const [r] = observationDealRows(WS, OBS, ['dealA'], 'human', { confidence: 0.3, decidedBy: 'user-9' });
  assert.equal(r.confidence, 1);
  assert.equal(r.decided_by, 'user-9');
});

test('inferred source: confidence is clamped into [0, 1] and decided_by is dropped', () => {
  assert.equal(observationDealRows(WS, OBS, ['d'], 'inferred', { confidence: 1.7, decidedBy: 'x' })[0].confidence, 1);
  assert.equal(observationDealRows(WS, OBS, ['d'], 'inferred', { confidence: -2 })[0].confidence, 0);
  assert.equal(observationDealRows(WS, OBS, ['d'], 'inferred', { confidence: 0.42, decidedBy: 'x' })[0].decided_by, null);
});

test('duplicates and blanks are dropped; nothing → no rows', () => {
  assert.equal(observationDealRows(WS, OBS, ['a', null, 'a', '', undefined], 'crm').length, 1);
  assert.deepEqual(observationDealRows(WS, OBS, [], 'crm'), []);
});
