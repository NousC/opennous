// Company entities resolve on `domain`. A company created without one carries no
// identifier at all, so every mention mints a new entity — which is how the
// a workspace ended up holding "Zelquorra.ai" and "Zelquorra" as two separate
// companies, both with a null domain. The old name fallback was an exact ilike, so
// those two never met.
//
// companyNameKey folds the differences that are spelling rather than identity. It
// is only ever consulted when there is no domain; a real domain always wins.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/companyNameKey.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyNameKey } from '../dist/utils/identity.js';

test('the Zelquorra case — a brand TLD is spelling, not identity', () => {
  const key = companyNameKey('Zelquorra.ai');
  assert.equal(key, 'zelquorra');
  for (const variant of ['Zelquorra', 'ZELQUORRA', 'zelquorra', 'Zelquorra, Inc.', 'Zelquorra Inc']) {
    assert.equal(companyNameKey(variant), key, variant);
  }
});

test('legal suffixes drop out', () => {
  const key = companyNameKey('Acme');
  for (const v of ['Acme Inc.', 'Acme LLC', 'Acme Ltd', 'Acme GmbH', 'ACME Corporation', 'The Acme Company']) {
    assert.equal(companyNameKey(v), key, v);
  }
});

test('punctuation and spacing are not identity', () => {
  assert.equal(companyNameKey('Acme-Box'), companyNameKey('Acme Box'));
  assert.equal(companyNameKey('acme_box'), companyNameKey('AcmeBox'));
});

test('different companies keep different keys', () => {
  assert.notEqual(companyNameKey('Harborline'), companyNameKey('Harbortrader'));
  assert.notEqual(companyNameKey('Starbridge'), companyNameKey('Starbridge Health'));
  assert.notEqual(companyNameKey('Teelo'), companyNameKey('Telo'));
});

test('an internal dot is part of the name, only a trailing brand TLD is stripped', () => {
  assert.equal(companyNameKey('a.b.consulting'), 'abconsulting');
  assert.equal(companyNameKey('Web.com Group'), 'web');   // and agrees with "Web.com"
  assert.equal(companyNameKey('Web.com'), companyNameKey('Web.com Group'));
});

test('too short to be a name returns null rather than collapsing unrelated firms', () => {
  assert.equal(companyNameKey('X'), null);
  assert.equal(companyNameKey('AB'), null);
  assert.equal(companyNameKey('Inc'), null);              // nothing but a suffix
  assert.equal(companyNameKey('   '), null);
  assert.equal(companyNameKey(null), null);
  assert.equal(companyNameKey(undefined), null);
});
