// The nightly sort keeps the account an insight was written with (GET-970).
//
// An agent names the account an insight came from (POST /v2/insights focus). Its source_ref can be
// one no observation carries, which resolves to no account, and the sort used to take that empty
// answer over the account the item already had, so the row fell off the board. A call that does
// give an account still decides it, so a re-sort keeps fixing accounts as it did.
//
// Run: node --test apps/worker/tests/insightPlacementAccount.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placementAccount } from '../src/workers/insightBoard.mjs';

const accounts = new Map([
  ['source://fireflies/m1', { contactId: 'p-call', companyId: 'c-call' }],
  ['git://repo/raw/x.md', { contactId: null, companyId: null }],
]);

test('a call that gives an account still decides it, so a re-sort recomputes it', () => {
  assert.deepEqual(placementAccount({ company_id: 'c-old', contact_id: 'p-old', source_ref: 'source://fireflies/m1' }, accounts),
    { contactId: 'p-call', companyId: 'c-call' });
});

test('a ref that resolves to nothing does not clear the account the item was written with', () => {
  assert.deepEqual(placementAccount({ company_id: 'c-named', contact_id: 'p-named', source_ref: 'git://repo/raw/x.md' }, accounts),
    { contactId: 'p-named', companyId: 'c-named' });
  assert.deepEqual(placementAccount({ company_id: 'c-named', contact_id: null, source_ref: null }, accounts),
    { contactId: null, companyId: 'c-named' });
});

test('an item with no account and no resolvable call stays without one', () => {
  assert.deepEqual(placementAccount({ company_id: null, contact_id: 'p-only', source_ref: null }, accounts),
    { contactId: 'p-only', companyId: null });
});
