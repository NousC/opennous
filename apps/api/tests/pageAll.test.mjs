import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageAll } from '../src/lib/pageAll.mjs';

// The 1000-row cap is invisible without a test.
//
// PostgREST returns exactly 1000 rows and no error when more match, so every failure mode
// here is silent and the output is PLAUSIBLE rather than empty. Nothing in production would
// have told us the revenue report's funnel was built from a fifth of the history. These tests
// stand in for the behaviour we cannot get the real client to demonstrate on demand.

/**
 * A fake Supabase builder over a fixed row set that enforces the 1000-row cap the way
 * PostgREST does: silently, by truncating, never by erroring.
 */
function fakeTable(rowCount, { cap = 1000, onRange = () => {} } = {}) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({ i }));
  return () => ({
    range(from, to) {
      onRange(from, to);
      const width = Math.min(to - from + 1, cap);
      return Promise.resolve({ data: rows.slice(from, from + width), error: null });
    },
  });
}

test('pageAll reads past the 1000-row cap', async () => {
  const rows = await pageAll(fakeTable(4321));
  assert.equal(rows.length, 4321, 'must read every row, not the first page');
  // Every row exactly once: a paged query that is not ordered can repeat one and drop
  // another, and the count alone would not catch it.
  assert.equal(new Set(rows.map((r) => r.i)).size, 4321, 'no duplicates, no gaps');
});

test('pageAll makes exactly one request when the data fits in one page', async () => {
  let calls = 0;
  const rows = await pageAll(fakeTable(12, { onRange: () => { calls += 1; } }));
  assert.equal(rows.length, 12);
  // The common case is a small workspace. Paying eight round-trips for twelve rows would
  // make every small read slower to fix a problem only large ones have.
  assert.equal(calls, 1, 'a short first page ends the read');
});

test('pageAll returns empty rather than throwing on no matches', async () => {
  assert.deepEqual(await pageAll(fakeTable(0)), []);
});

test('pageAll handles a row count that lands exactly on a page boundary', async () => {
  // 2000 rows is the case where the second page is full and the third is empty — an
  // off-by-one here either drops the last page or loops forever.
  const rows = await pageAll(fakeTable(2000));
  assert.equal(rows.length, 2000);
});

test('pageAll propagates an error instead of returning a short read', async () => {
  // The bug this guards: the old code wrapped these queries in
  // `.then(r => r, () => ({ data: [] }))`, so a rejected request became an empty result and
  // "this workspace has no observations" — which is what it reported for a workspace holding
  // tens of thousands of them. A failure must be loud.
  const build = () => ({ range: () => Promise.resolve({ data: null, error: new Error('url too long') }) });
  await assert.rejects(() => pageAll(build), /url too long/);
});

test('pageAll stops at the cap rather than reading forever', async () => {
  const rows = await pageAll(fakeTable(50000), { cap: 3000 });
  assert.ok(rows.length <= 3000 + 1000, `bounded read, got ${rows.length}`);
});

test('pageAll requires a fresh builder per call', async () => {
  // Documents the contract that broke the first draft: a PostgREST builder cannot be
  // re-ranged after being awaited, so reusing one instance yields the same page repeatedly.
  // A caller passing a builder rather than a factory would see duplicates, not an error.
  const seen = [];
  await pageAll(fakeTable(2500, { onRange: (from) => seen.push(from) }));
  assert.equal(new Set(seen).size, seen.length, 'every page requested a distinct offset');
});
