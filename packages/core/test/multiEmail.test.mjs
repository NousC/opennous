// Unit tests for multi-email capture in identifiersFromContactData — a person
// with a work + personal address must yield an `email` identifier for EACH, so
// resolution keys on any of them (the Rayyan case: rayyan.sk@alibaba-inc.com +
// rayyan.shaik2@gmail.com).
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/multiEmail.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifiersFromContactData } from '../dist/db/entities.js';

const emails = (ids) => ids.filter(i => i.kind === 'email').map(i => i.value);

test('single email still works (back-compat)', () => {
  const ids = identifiersFromContactData({ email: 'rayyan.sk@alibaba-inc.com' });
  assert.deepEqual(emails(ids), ['rayyan.sk@alibaba-inc.com']);
});

test('email + emails[] yields one identifier per address, primary first', () => {
  const ids = identifiersFromContactData({
    email: 'rayyan.sk@alibaba-inc.com',
    emails: ['rayyan.shaik2@gmail.com'],
  });
  assert.deepEqual(emails(ids), ['rayyan.sk@alibaba-inc.com', 'rayyan.shaik2@gmail.com']);
});

test('emails[] alone (no primary) still captures all', () => {
  const ids = identifiersFromContactData({
    emails: ['a@work.com', 'b@gmail.com'],
  });
  assert.deepEqual(emails(ids), ['a@work.com', 'b@gmail.com']);
});

test('duplicates across email + emails[] are deduped case-insensitively', () => {
  const ids = identifiersFromContactData({
    email: 'Rayyan.SK@alibaba-inc.com',
    emails: ['rayyan.sk@alibaba-inc.com', 'rayyan.shaik2@gmail.com', null, ''],
  });
  assert.deepEqual(emails(ids), ['Rayyan.SK@alibaba-inc.com', 'rayyan.shaik2@gmail.com']);
});

test('non-email identifiers unaffected', () => {
  const ids = identifiersFromContactData({
    email: 'a@work.com',
    emails: ['b@gmail.com'],
    linkedin_url: 'https://www.linkedin.com/in/rayyan-sk',
  });
  assert.equal(ids.filter(i => i.kind === 'email').length, 2);
  assert.equal(ids.filter(i => i.kind === 'linkedin_url').length, 1);
});
