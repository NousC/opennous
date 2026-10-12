// The "already read" markers must not scan the workspace (GET-412).
//
// Structural, like the api's taskAccountBinding scan test: the queries need a live database, and
// the property under test is invisible in review and fatal in production — a prefix LIKE on
// `property` cannot use claims_ws_property_live, reads hundreds of thousands of rows per page, and times out. A
// timed-out marker reports every meeting as unread, and the backfill re-buys the year.
//
// Run: node --test apps/worker/tests/fellowBackfillMarkers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the backfill markers read note.* claims by range, never by prefix LIKE', async () => {
  const src = await readFile(new URL('../scripts/fellowBackfill.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /\.like\(\s*'property'\s*,\s*'note\.%'\s*\)/, 'a prefix LIKE on property is a seq scan (GET-396)');
  const ranges = code.match(/\.gte\('property',\s*'note\.'\)\s*\.lt\('property',\s*'note\/'\)/g) ?? [];
  assert.ok(ranges.length >= 2, `both markers use the half-open range (found ${ranges.length})`);
});
