// Which timing wins for a meeting action item.
//
// Fireflies gives action items as prose with no due field, so the timing has to
// be read out of the words. Two readers can do it: the model (accurate, needs a
// key and a working API) and a deterministic scan (always available, deliberately
// cautious). The rule for combining them is the whole point of this file, and it
// is easy to get backwards:
//
//   The model's answer wins whenever it HAS one — including when that answer is
//   "no deadline here". Falling back to the scan on a model null would put back
//   the invented due dates the model pass exists to remove.
//
//   The scan is only for items the model never saw: no API key, a failed call,
//   or an item past the batch cap.
//
// Run: pnpm --filter ./apps/worker run test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseDuePhrase, parseActionItems } from '../src/utils/actionItems.mjs';

test('the model wins when it has an answer', () => {
  const model = new Map([[0, 'by Friday']]);
  assert.equal(chooseDuePhrase(model, 0, 'Send the deck by Friday'), 'by Friday');
});

test('the model wins when its answer is "no deadline"', () => {
  // The scan would say "by Friday" here. The model saw the item and judged it
  // has no deadline, so that stands — this is the case the merge must not undo.
  const model = new Map([[0, null]]);
  assert.equal(chooseDuePhrase(model, 0, 'Send the deck by Friday'), null);
});

test('a failed model pass falls back to the deterministic scan', () => {
  // extractDuePhrasesWithModel returns null when it did not run at all.
  assert.equal(chooseDuePhrase(null, 0, 'Send the deck by Friday'), 'by Friday');
  assert.equal(chooseDuePhrase(undefined, 0, 'Circle back in 3 days'), 'in 3 days');
});

test('an item the model never saw falls back to the scan', () => {
  // Past the batch cap: the map exists but has no entry for this index, so the
  // item must not inherit the model's silence about other items.
  const model = new Map([[0, 'by Friday']]);
  assert.equal(chooseDuePhrase(model, 7, 'Send the pricing by Monday'), 'by Monday');
});

test('the fallback scan does not invent deadlines from naming words', () => {
  // The floor beneath the model still has to be safe on its own.
  assert.equal(chooseDuePhrase(null, 0, 'Share the Monday standup notes'), null);
  assert.equal(chooseDuePhrase(null, 0, 'Send the 30 days pilot proposal'), null);
  assert.equal(chooseDuePhrase(null, 0, 'Send the Black Friday deck to Mirela'), null);
});

test('parseActionItems still splits Fireflies markdown by owner', () => {
  const parsed = parseActionItems([
    '**Dorian Pelletreau**',
    'Share the MVP within ~2 weeks (21:14)',
    '**Saskia Vantermeer**',
    'Send the calendar link (22:05)',
  ].join('\n'));
  assert.deepEqual(parsed, [
    { owner_name: 'Dorian Pelletreau', title: 'Share the MVP within ~2 weeks' },
    { owner_name: 'Saskia Vantermeer', title: 'Send the calendar link' },
  ]);
});
