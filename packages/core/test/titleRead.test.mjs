// GET-276: a job title places someone in the buying decision. Titles from the Harborline pilot.
// Run: pnpm --filter @nous/core build && node --test packages/core/test/titleRead.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTitle } from '../dist/index.js';

const read = (t) => { const r = readTitle(t); return `${r.tier}/${r.role}`; };

test('dealership titles land in the right tier and role', () => {
  assert.equal(read('General Manager'), 'leadership/decision_maker', 'the GM signs — the old regex missed this');
  assert.equal(read('Managing Director'), 'executive/decision_maker');
  assert.equal(read('Chief Operating Officer'), 'executive/decision_maker');
  assert.equal(read('VP of Automotive Operations'), 'leadership/decision_maker');
  assert.equal(read('Controller'), 'leadership/economic_buyer');
  assert.equal(read('Finance Director'), 'leadership/economic_buyer');
  assert.equal(read('CFO'), 'executive/economic_buyer');
  assert.equal(read('New Car Sales Manager/ General Sales Manager'), 'leadership/null');
  assert.equal(read('Finance Manager (F&I)'), 'manager/null', 'F&I is a sales seat, not the budget');
  assert.equal(read('Sales Advisor/Finance Manager'), 'manager/null');
  assert.equal(read('Sales Associate'), 'staff/null');
  assert.equal(read('Web Developer'), 'staff/null');
  assert.equal(read('Product Owner'), 'staff/null');
  assert.equal(read('Partner Manager'), 'manager/null');
  assert.equal(read(null), 'null/null');
});
