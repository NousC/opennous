// Unit tests for the normalised email local-part identity tier
// (docs/identity-resolution.md §Planned). Pure functions, no DB.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/localPartMatch.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmailLocalPart, emailDomain, pickLocalPartMatch } from '../dist/utils/identity.js';

test('normalizeEmailLocalPart strips digits, dots, plus-tags to letters', () => {
  assert.equal(normalizeEmailLocalPart('sarahwig9@gmail.com'), 'sarahwig');
  assert.equal(normalizeEmailLocalPart('sarahwig15@gmail.com'), 'sarahwig');
  assert.equal(normalizeEmailLocalPart('jordan.lee+work@acme.com'), 'jordanlee');
  assert.equal(normalizeEmailLocalPart('jordanlee03@gmail.com'), 'jordanlee');
});

test('normalizeEmailLocalPart rejects too-generic (<4 letters) and malformed', () => {
  assert.equal(normalizeEmailLocalPart('jl3@gmail.com'), null);      // only 2 letters
  assert.equal(normalizeEmailLocalPart('123@gmail.com'), null);      // no letters
  assert.equal(normalizeEmailLocalPart('@gmail.com'), null);
  assert.equal(normalizeEmailLocalPart('notanemail'), null);
  assert.equal(normalizeEmailLocalPart(null), null);
});

test('emailDomain lowercases and drops www', () => {
  assert.equal(emailDomain('a@Gmail.com'), 'gmail.com');
  assert.equal(emailDomain('a@www.acme.com'), 'acme.com');
  assert.equal(emailDomain('bad'), null);
});

test('pickLocalPartMatch: the Sarah Wig case — unique same-domain twin resolves', () => {
  const existing = [{ entity_id: 'linkedin-sarah', email: 'sarahwig15@gmail.com' }];
  assert.equal(pickLocalPartMatch(['sarahwig9@gmail.com'], existing), 'linkedin-sarah');
});

test('pickLocalPartMatch: different domain never collapses', () => {
  const existing = [{ entity_id: 'e1', email: 'sarahwig15@acme.com' }];
  assert.equal(pickLocalPartMatch(['sarahwig9@gmail.com'], existing), null);
});

test('pickLocalPartMatch: ambiguous (two candidates share the key) → null, never guess', () => {
  const existing = [
    { entity_id: 'e1', email: 'sarahwig15@gmail.com' },
    { entity_id: 'e2', email: 'sarahwig22@gmail.com' },
  ];
  assert.equal(pickLocalPartMatch(['sarahwig9@gmail.com'], existing), null);
});

test('pickLocalPartMatch: identical email is Step 1s job, not this tier', () => {
  const existing = [{ entity_id: 'e1', email: 'sarahwig9@gmail.com' }];
  assert.equal(pickLocalPartMatch(['sarahwig9@gmail.com'], existing), null);
});

test('pickLocalPartMatch: no distinctive incoming key → null', () => {
  const existing = [{ entity_id: 'e1', email: 'jl3@gmail.com' }];
  assert.equal(pickLocalPartMatch(['jl3@gmail.com'], existing), null);
});

test('pickLocalPartMatch: two entities but only ONE matches the incoming key → resolves', () => {
  const existing = [
    { entity_id: 'sarah', email: 'sarahwig15@gmail.com' },
    { entity_id: 'bob', email: 'bobjones4@gmail.com' },
  ];
  assert.equal(pickLocalPartMatch(['sarahwig9@gmail.com'], existing), 'sarah');
});
