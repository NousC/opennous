// A claim is the deal's when its source observation is (GET-404).
// Run: node --test apps/api/tests/dealIntel.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimFiledToDeal } from '../src/lib/accountDeals.mjs';

const attributed = new Set(['obs-1', 'obs-2']);

test('the extractor\'s evidence chain files the claim to the deal', () => {
  assert.equal(claimFiledToDeal({ supporting_observation_ids: ['obs-9', 'obs-2'], metadata: {} }, attributed), true);
});

test('older rows that carry the source only in metadata are filed too', () => {
  assert.equal(claimFiledToDeal({ supporting_observation_ids: [], metadata: { source_activity_id: 'obs-1' } }, attributed), true);
  assert.equal(claimFiledToDeal({ supporting_observation_ids: [], metadata: { source_observation_ids: ['obs-2'] } }, attributed), true);
});

test('a claim from a conversation not attributed to the deal stays the account\'s', () => {
  assert.equal(claimFiledToDeal({ supporting_observation_ids: ['obs-7'], metadata: { source_activity_id: 'obs-8' } }, attributed), false);
  assert.equal(claimFiledToDeal({ metadata: {} }, attributed), false);
});

test('a deal with nothing attributed files nothing — the roster fallback is explicit, never silent', () => {
  assert.equal(claimFiledToDeal({ supporting_observation_ids: ['obs-1'], metadata: {} }, new Set()), false);
  assert.equal(claimFiledToDeal({ supporting_observation_ids: ['obs-1'], metadata: {} }, undefined), false);
});
