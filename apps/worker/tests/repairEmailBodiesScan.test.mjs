// The repair script's scan, pinned structurally (GET-396).
//
// The first full dry run died before printing a single line. `property LIKE 'interaction.email%'`
// cost seconds for the FIRST page — a prefix LIKE cannot use the btree under the default
// collation, so it degrades into a filtered walk of the primary key — and the statement
// timeout killed it. Naming both properties takes the same page to tens of milliseconds.
//
// That is the THIRD run today lost to this shape: GET-329's read marker did it with
// 'noema.read.gmail_%' (hundreds of thousands of rows, seconds), and the bounded scan before that.
//
// The tempting fix is worse than the bug: `raw->>'text' is null` in the query forces a detoast of
// every body and takes the page past a minute. The emptiness test belongs in JS.
//
// A script with top-level await and a live Supabase client cannot be unit-tested without a
// database, so this is checked structurally — the same tactic as modelDoorGuard and
// gmailReadWiring, both of which caught real regressions.
//
// Run: node --test apps/worker/tests/repairEmailBodiesScan.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../scripts/repairEmailBodies.mjs', import.meta.url), 'utf8');

test('the scan names both properties instead of matching a prefix', () => {
  assert.match(SRC, /\.in\('property', EMAIL_PROPERTIES\)/);
  assert.match(SRC, /'interaction\.email_sent'/);
  assert.match(SRC, /'interaction\.email_received'/);
});

test('no prefix LIKE on property anywhere in the script', () => {
  // Written as a scan of the source rather than a check of one call site: the cost is the same
  // wherever it appears, and this file will grow.
  const offenders = SRC.split('\n').filter(l =>
    /\.like\(\s*'property'/.test(l) && !l.trim().startsWith('//'));
  assert.deepEqual(offenders, [], 'prefix LIKE on an indexed column is a scan wearing a filter');
});

test('the emptiness test is not pushed into the query', () => {
  const offenders = SRC.split('\n').filter(l =>
    /\.is\(\s*'raw->>/.test(l) && !l.trim().startsWith('//'));
  assert.deepEqual(offenders, [], 'raw->>text is null forces a detoast of every body — over a minute');
});

test('a timed-out page is halved and retried, not fatal', () => {
  assert.match(SRC, /57014/, 'the timeout code has to be recognised to be survived');
  assert.match(SRC, /pageSize = Math\.floor\(pageSize \/ 2\)/);
});

test('the page size variable is not shadowed by the page it fetches', () => {
  // A previous fix of exactly this shape introduced `const page = data ?? []` inside a loop whose
  // parameter was also `page`, and died with "Cannot access 'page' before initialization".
  // node --check passes that file; nothing executed it (GET-329, #289).
  const fn = SRC.slice(SRC.indexOf('async function findEmptyRows'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /let pageSize = PAGE;/);
  assert.doesNotMatch(body, /const pageSize\b/, 'the loop must not redeclare its own page size');
  assert.match(body, /if \(rows\.length < pageSize\) return out;/,
    'the tail test must use the CURRENT page size, or a halved page ends the scan early');
});
