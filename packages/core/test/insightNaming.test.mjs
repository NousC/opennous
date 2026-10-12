// Naming topics in batches, and naming small ones without a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRowsSummaryPrompt, parseRowsSummary, BOARD_MODEL_NAME_MIN_ACCOUNTS, BOARD_NAME_BATCH } from '../dist/db/insightBoard.js';

test('one prompt carries several topics, each with its own numbered statements', () => {
  const p = buildRowsSummaryPrompt([
    { tagName: 'Kiosk mode', subtypeKey: 'feature', items: [{ statement: 'a' }, { statement: 'b' }] },
    { tagName: 'Motorlane', subtypeKey: 'partners', items: [{ statement: 'c' }] },
  ], null, 'software');
  assert.match(p, /### Topic 0: "Kiosk mode"/);
  assert.match(p, /### Topic 1: "Motorlane"/);
  assert.equal((p.match(/WHO WE ARE/g) || []).length, 0, 'no context given, none sent');
});

test('each entry is read against its own topic; skipped or garbled topics are null', () => {
  const out = parseRowsSummary(JSON.stringify({ rows: [
    { k: 1, headline: 'Motorlane is the incumbent', problems: [], receipts: [0, 7] },
    { k: 0, headline: '', problems: [] },
  ] }), [2, 1, 3]);
  assert.equal(out[0], null, 'an empty headline is not an answer');
  assert.equal(out[1].headline, 'Motorlane is the incumbent');
  assert.deepEqual(out[1].receipts, [0], 'statement 7 does not exist in a one-statement topic');
  assert.equal(out[2], null, 'topic 2 was skipped');
  assert.equal(parseRowsSummary('no json', [1]), null);
});

test('small topics skip the model; the rest go ten to a call', () => {
  assert.equal(BOARD_MODEL_NAME_MIN_ACCOUNTS, 2);
  assert.equal(BOARD_NAME_BATCH, 10);
});
