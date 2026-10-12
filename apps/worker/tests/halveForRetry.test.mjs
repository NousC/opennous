// A chunk the model could not answer is read again as two halves (GET-415).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { halveForRetry, PART_OVERLAP } from '../src/signals/extractionText.mjs';

const line = (i) => `Speaker ${i % 3}: sentence number ${i} of the transcript, long enough to be a turn.\n`;
const long = Array.from({ length: 400 }, (_, i) => line(i)).join('');

test('a long chunk splits at a turn boundary into two overlapping halves', () => {
  const halves = halveForRetry(long);
  assert.ok(halves && halves.length === 2);
  const [a, b] = halves;
  assert.ok(a.endsWith('\n') || !a.includes('\n') , 'first half ends on a line');
  assert.ok(a.length > long.length / 4 && a.length < long.length * 3 / 4, 'roughly half');
  assert.equal(a.slice(-PART_OVERLAP) === b.slice(0, PART_OVERLAP) || b.startsWith(a.slice(a.length - PART_OVERLAP)), true, 'the halves overlap by a turn');
  assert.ok(b.endsWith(long.slice(-40)), 'nothing at the end is lost');
});

test('a short chunk has nothing to halve — the caller records the loss instead', () => {
  assert.equal(halveForRetry('short text'), null);
  assert.equal(halveForRetry(''), null);
  assert.equal(halveForRetry(null), null);
});
