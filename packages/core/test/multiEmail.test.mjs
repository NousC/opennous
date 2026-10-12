// Unit tests for multi-email capture in identifiersFromContactData — a person
// with a work + personal address must yield an `email` identifier for EACH, so
// resolution keys on any of them (the Ilsa case: ilsa.v@bigcorp.example +
// ilsa.varnholt@mail.example).
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/multiEmail.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifiersFromContactData } from '../dist/db/entities.js';

const emails = (ids) => ids.filter(i => i.kind === 'email').map(i => i.value);

test('single email still works (back-compat)', () => {
  const ids = identifiersFromContactData({ email: 'ilsa.v@bigcorp.example' });
  assert.deepEqual(emails(ids), ['ilsa.v@bigcorp.example']);
});

test('email + emails[] yields one identifier per address, primary first', () => {
  const ids = identifiersFromContactData({
    email: 'ilsa.v@bigcorp.example',
    emails: ['ilsa.varnholt@mail.example'],
  });
  assert.deepEqual(emails(ids), ['ilsa.v@bigcorp.example', 'ilsa.varnholt@mail.example']);
});

test('emails[] alone (no primary) still captures all', () => {
  const ids = identifiersFromContactData({
    emails: ['a@work.example', 'b@personal.example'],
  });
  assert.deepEqual(emails(ids), ['a@work.example', 'b@personal.example']);
});

test('duplicates across email + emails[] are deduped case-insensitively', () => {
  const ids = identifiersFromContactData({
    email: 'Ilsa.V@bigcorp.example',
    emails: ['ilsa.v@bigcorp.example', 'ilsa.varnholt@mail.example', null, ''],
  });
  assert.deepEqual(emails(ids), ['Ilsa.V@bigcorp.example', 'ilsa.varnholt@mail.example']);
});

test('non-email identifiers unaffected', () => {
  const ids = identifiersFromContactData({
    email: 'a@work.example',
    emails: ['b@personal.example'],
    linkedin_url: 'https://www.linkedin.com/in/ilsa-v',
  });
  assert.equal(ids.filter(i => i.kind === 'email').length, 2);
  assert.equal(ids.filter(i => i.kind === 'linkedin_url').length, 1);
});
