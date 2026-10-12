// The board's buttons follow what the business sells, and the sorter may say "not an insight".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardTaxonomy, buildSortPrompt, parseSortAnswer, NOT_AN_INSIGHT, BOARD_SUMMARY_MIN_ACCOUNTS } from '../dist/db/insightBoard.js';

test('a service business sees Delivery, not Product; the keys stay the same', () => {
  const sw = boardTaxonomy('software'), sv = boardTaxonomy('service');
  assert.equal(sw.lanes.find(l => l.key === 'product').label, 'Product');
  assert.equal(sv.lanes.find(l => l.key === 'product').label, 'Delivery');
  assert.equal(sv.subtypes.find(s => s.key === 'bug').label, 'Missed results');
  assert.equal(sv.subtypes.find(s => s.key === 'feature').label, 'Service request');
  assert.deepEqual(sv.subtypes.map(s => s.key), sw.subtypes.map(s => s.key));
});

test('the sort prompt tells a service business it has no product, and offers "none"', () => {
  const p = buildSortPrompt([{ statement: 'x' }], [], null, 'service');
  assert.match(p, /We sell a SERVICE/);
  assert.match(p, /Missed results/);
  assert.match(p, new RegExp(`- ${NOT_AN_INSIGHT} = NOT the customer's own view`));
  assert.doesNotMatch(buildSortPrompt([{ statement: 'x' }], [], null, 'software'), /We sell a SERVICE/);
});

test('"none" parses as not-an-insight; unknown buttons are still dropped', () => {
  const out = parseSortAnswer(JSON.stringify({ items: [
    { i: 0, b: 'none', tags: ['X'] }, { i: 1, b: 'objection', tags: ['Pilot'] }, { i: 2, b: 'made-up', tags: [] },
  ] }), 3, ['Pilot']);
  assert.equal(out[0].subtype, NOT_AN_INSIGHT);
  assert.deepEqual(out[0].tags, []);
  assert.equal(out[1].subtype, 'objection');
  assert.equal(out[2], null);
});

test('every topic gets a name, not only the ones three accounts raised', () => {
  assert.equal(BOARD_SUMMARY_MIN_ACCOUNTS, 1);
});

test('named companies get their own tag, and lead the grouping', async () => {
  const { buildTagListPrompt } = await import('../dist/db/insightBoard.js');
  const p = buildTagListPrompt(['Motorlane is what they use'], [], null);
  assert.match(p, /NAMED gets its own tag, named exactly as it is called/);
  assert.match(buildSortPrompt([{ statement: 'x' }], [], null), /if it names a competitor, vendor or tool, that company's tag goes first/);
});
