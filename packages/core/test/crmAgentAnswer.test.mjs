// The learning label: what a human's answer means for the ranking that proposed it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdictForAnswer, activityGroupKey } from '../dist/services/crmAgent.js';

test('taking the top pick exactly is accepted', () => {
  assert.equal(verdictForAnswer('A', 'deal', ['A']), 'accepted');
});

test('a different deal, or more than one, is edited (a correction to learn from)', () => {
  assert.equal(verdictForAnswer('A', 'deal', ['B']), 'edited');
  assert.equal(verdictForAnswer('A', 'deal', ['A', 'B']), 'edited');
  assert.equal(verdictForAnswer('A', 'both', ['A', 'B']), 'edited');
});

test('neither, or nothing chosen, is rejected', () => {
  assert.equal(verdictForAnswer('A', 'neither', []), 'rejected');
  assert.equal(verdictForAnswer('A', 'deal', []), 'rejected');
  assert.equal(verdictForAnswer(null, 'deal', ['A']), 'edited');
});

test('group key: one question per meeting, not per attendee', () => {
  const a = activityGroupKey({ rawData: { note_id: 'n-42' }, externalId: 'granola_n-42_11111111-1111-1111-1111-111111111111', entityId: 'p1' });
  const b = activityGroupKey({ rawData: { note_id: 'n-42' }, externalId: 'granola_n-42_22222222-2222-2222-2222-222222222222', entityId: 'p2' });
  assert.equal(a, b);
  assert.equal(a, 'n-42');
});

test('group key: falls back to the external id minus its per-contact tail', () => {
  const k = activityGroupKey({ rawData: {}, externalId: 'fireflies_abc_33333333-3333-3333-3333-333333333333', entityId: 'p' });
  assert.equal(k, 'fireflies_abc');
  assert.equal(activityGroupKey({ rawData: {}, externalId: 'plain-id', entityId: 'p' }), 'plain-id');
  assert.equal(activityGroupKey({ rawData: null, externalId: null, entityId: 'p' }), null);
});
