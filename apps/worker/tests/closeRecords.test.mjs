// The loader's pure parts (GET-405): a claim row becomes evidence with its attribution, and the
// worker's touch definition matches the API's. Run: node --test apps/worker/tests/closeRecords.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evidenceFromClaim, isTouch, NOT_A_TOUCH } from '../src/workers/closeRecords.mjs';

test('a claim row becomes evidence, filed to the deal when its source conversation is', () => {
  const row = { id: 'c1', entity_id: 'p1', valid_from: '2026-07-05T00:00:00Z', supporting_observation_ids: ['o9'],
    value: { category: 'Objection', content: 'Too expensive', metadata: { quote: 'too expensive for us', occurred_at: '2026-07-03T00:00:00Z', status: 'open', hardness: 'hard' } } };
  const e = evidenceFromClaim(row, new Set(['o9']));
  assert.equal(e.category, 'objection');
  assert.equal(e.at, '2026-07-03T00:00:00Z', 'dated by when it was said, not when it was recorded');
  assert.equal(e.status, 'open');
  assert.equal(e.filedToDeal, true);
  assert.equal(evidenceFromClaim(row, new Set(['other'])).filedToDeal, false);
  // Older rows carry the source only in metadata.
  const old = { ...row, supporting_observation_ids: [], value: { ...row.value, metadata: { ...row.value.metadata, source_activity_id: 'o9' } } };
  assert.equal(evidenceFromClaim(old, new Set(['o9'])).filedToDeal, true);
});

test('the worker\'s touch definition is the API\'s, verbatim', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const api = readFileSync(join(here, '..', '..', 'api', 'src', 'lib', 'activityKinds.mjs'), 'utf8');
  const m = api.match(/const NOT_A_TOUCH = (\/.*\/);/);
  assert.ok(m, 'could not find NOT_A_TOUCH in activityKinds.mjs');
  assert.equal(NOT_A_TOUCH.source, new Function(`return ${m[1]}`)().source);
  assert.equal(isTouch({ property: 'interaction.email_received' }), true);
  assert.equal(isTouch({ property: 'interaction.email_opened' }), false);
  assert.equal(isTouch({ property: 'stage' }), false);
});
