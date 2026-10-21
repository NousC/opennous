// An insight rests on a checked quote, and a re-read of the same source does not file it again (GET-974).
//
// Insight quotes were never checked: claims went through the verbatim grounding check, insights went
// straight onto the page as "receipts". And one email thread, read again on every new reply, filed
// the same point about fourteen times in reworded form, which an 80-character text key cannot catch.
//
// Run: node --test apps/worker/tests/insightEvidence.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundInsights, newInsights, INSIGHT_REPEAT_SIMILARITY } from '../src/signals/insights.mjs';

const transcript = [
  'Hollis Vane: Nobody on my team is going to log into one more tool. If it shows up in Slack, they will read it.',
  'Sorrel Quist: We can push a daily digest into Slack for you.',
  'Hollis Vane: Honestly the pricing page confused me, I could not tell what a credit is.'
].join('\n');

test('an insight whose quote is in the source keeps it', () => {
  const { kept, dropped } = groundInsights([{ category: 'product', content: 'Push changes to Slack', quote: 'If it shows up in Slack, they will read it' }], { sourceText: transcript });
  assert.equal(dropped, 0);
  assert.equal(kept[0].quote, 'If it shows up in Slack, they will read it');
});

test('an insight whose quote is not in the source is dropped', () => {
  const { kept, dropped } = groundInsights([
    { category: 'product', content: 'Wants a mobile app', quote: 'we really need a mobile app for the floor' },
    { category: 'product', content: 'No quote at all' }
  ], { sourceText: transcript });
  assert.equal(kept.length, 0);
  assert.equal(dropped, 2);
});

test('a line our own side spoke is not their evidence', () => {
  const { kept, dropped } = groundInsights([{ category: 'product', content: 'Daily digest in Slack', quote: 'We can push a daily digest into Slack for you' }],
    { sourceText: transcript, ourNames: ['Sorrel Quist'] });
  assert.equal(kept.length, 0);
  assert.equal(dropped, 1);
});

test('an email insight is checked against their side of the thread only', () => {
  const thread = '--- us · Sorrel Quist ---\nWould a Slack digest help?\n--- them · Hollis Vane ---\nYes, a digest in Slack every morning would help.';
  const theirs = thread.split('--- them · Hollis Vane ---')[1];
  assert.equal(groundInsights([{ category: 'product', content: 'x', quote: 'Would a Slack digest help' }], { sourceText: theirs }).kept.length, 0);
  assert.equal(groundInsights([{ category: 'product', content: 'x', quote: 'a digest in Slack every morning would help' }], { sourceText: theirs }).kept.length, 1);
});

const v = (...xs) => xs;
test('a reworded repeat from the same source is not filed again', () => {
  assert.equal(INSIGHT_REPEAT_SIMILARITY, 0.85);
  const items = [{ category: 'product', content: 'Buyers want activity summaries pushed into Slack' }, { category: 'market', content: 'Agencies need a data layer' }];
  const existing = [{ category: 'product', statement: 'Buyers want activity summaries delivered to Slack' }];
  const out = newInsights(items, [v(1, 0, 0), v(0, 1, 0)], existing, [v(0.98, 0.2, 0)]);
  assert.deepEqual(out.map(x => x.category), ['market']);
});

test('the same point in another category, or a different point, is kept', () => {
  const items = [{ category: 'positioning', content: 'Slack' }, { category: 'product', content: 'Pricing confuses' }];
  const existing = [{ category: 'product', statement: 'Slack digests' }];
  const out = newInsights(items, [v(1, 0, 0), v(0, 1, 0)], existing, [v(1, 0, 0)]);
  assert.equal(out.length, 2);
});

test('two copies inside one read become one', () => {
  const items = [{ category: 'product', content: 'Slack digests' }, { category: 'product', content: 'Digests in Slack' }];
  assert.equal(newInsights(items, [v(1, 0), v(0.99, 0.05)], [], []).length, 1);
});

// ── Phase 0.7: repeats already stored ────────────────────────────────────────
import { storedRepeats } from '../src/signals/insights.mjs';

const row = (id, o) => ({ id, workspace_id: 'w1', source: 'external', category: 'product', source_ref: 'source://gmail/t1', company_id: 'c1', created_at: `2026-10-1${id.length}T00:00:00Z`, ...o });

test('stored repeats from one source collapse to the oldest, chaining through rewordings', () => {
  const rows = [row('a', { created_at: '2026-10-12T05:00:00Z' }), row('b', { created_at: '2026-10-12T06:00:00Z' }), row('c', { created_at: '2026-10-12T07:00:00Z' })];
  // a~b and b~c, but a and c are not close: still one point, reworded a little each time.
  const vec = { a: [1, 0, 0], b: [0.9, 0.44, 0], c: [0.6, 0.8, 0] };
  const out = storedRepeats(rows, (id) => vec[id]);
  assert.equal(out.length, 1);
  assert.equal(out[0].keep.id, 'a');
  assert.deepEqual(out[0].repeats.map((r) => r.id), ['b', 'c']);
});

test('the same point from another account, source or category is not a repeat', () => {
  const rows = [
    row('a'), row('b', { source_ref: 'source://gmail/t2', company_id: 'c2' }),
    row('c', { category: 'market' }), row('d', { source_ref: null, company_id: null }), row('e', { source_ref: null, company_id: null }),
  ];
  assert.deepEqual(storedRepeats(rows, () => [1, 0]), []);
});

test('with no ref, the account stands in for the source', () => {
  const rows = [row('a', { source_ref: null }), row('bb', { source_ref: null })];
  assert.equal(storedRepeats(rows, () => [1, 0]).length, 1);
});
