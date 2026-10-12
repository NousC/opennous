// Which companies are the same customer, and which of them is the more specific.
//
// A dealer group is one customer with many front doors: Brindlecrest Auto Group carries a dozen
// rooftops in Harborline's CRM. These pin the two questions every reader asks of that — same customer? and
// which is the narrower answer? — plus the rule that matters most: with no hierarchy loaded,
// everything behaves exactly as it did before hierarchy existed.
//
// Pure: no database.
//
// Run: node --test apps/worker/tests/companyFamily.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameCompanyFamily, mostSpecificInFamily } from '@nous/core';

// Brindlecrest Auto Group, two of its rooftops, and an unrelated dealership.
const GROUP = 'brindlecrest-group', NORTH = 'brindlecrest-north', SOUTH = 'brindlecrest-south', FALLOWMERE_VW = 'fallowmere-vw';
const parents = new Map([[NORTH, GROUP], [SOUTH, GROUP]]);

test('a rooftop and its group are the same customer', () => {
  assert.equal(sameCompanyFamily(NORTH, GROUP, parents), true);
  assert.equal(sameCompanyFamily(GROUP, NORTH, parents), true);
});

test('two rooftops of one group are the same customer', () => {
  assert.equal(sameCompanyFamily(NORTH, SOUTH, parents), true);
});

test('an unrelated dealership is not', () => {
  assert.equal(sameCompanyFamily(NORTH, FALLOWMERE_VW, parents), false);
  assert.equal(sameCompanyFamily(GROUP, FALLOWMERE_VW, parents), false);
});

test('the rooftop is the more specific answer, whichever way round it is asked', () => {
  assert.equal(mostSpecificInFamily(NORTH, GROUP, parents), NORTH);
  assert.equal(mostSpecificInFamily(GROUP, NORTH, parents), NORTH);
});

test('across families there is no winner — the caller must decide on its own evidence', () => {
  assert.equal(mostSpecificInFamily(FALLOWMERE_VW, NORTH, parents), null);
});

test('with no hierarchy loaded, nothing is family but itself', () => {
  // The state of every workspace before the sync wrote a single edge. Callers fall back to
  // whatever they did before, which is the only safe behaviour for missing data.
  assert.equal(sameCompanyFamily(NORTH, GROUP), false);
  assert.equal(mostSpecificInFamily(NORTH, GROUP), null);
  assert.equal(sameCompanyFamily(NORTH, NORTH), true);
  assert.equal(mostSpecificInFamily(NORTH, NORTH), NORTH);
});

test('a missing side is never a family', () => {
  assert.equal(sameCompanyFamily(null, GROUP, parents), false);
  assert.equal(sameCompanyFamily(NORTH, undefined, parents), false);
  assert.equal(mostSpecificInFamily(null, null, parents), null);
});
