// Resolving a name is not the same as guessing one.
//
// "Vela" matched inside "Ignatius MarVELAnce", one candidate came back, and one candidate
// always resolved — so the agent briefed the wrong person and reported his empty pipeline as
// a fact about the deal that was actually asked about. A confident wrong answer.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/entities.resolveFocus.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The classifier, mirrored from searchEntitiesByName. If it drifts, these tests are the alarm.
function matchOf(needle, full, first, last, company) {
  const hay = full.toLowerCase(), fl = first.toLowerCase(), ll = last.toLowerCase();
  const n = needle.toLowerCase();
  if (hay === n || fl === n || ll === n) return 'exact';
  if (hay.startsWith(n) || fl.startsWith(n) || ll.startsWith(n)) return 'prefix';
  if (hay.includes(n)) return 'contains';
  if (company && company.toLowerCase().includes(n)) return 'company';
  return null;
}
const resolvesAlone = (m) => m === 'exact' || m === 'prefix';

test('a first-name prefix resolves — that is how people refer to each other', () => {
  assert.equal(matchOf('Vik', 'Viktor Aldane', 'Viktor', 'Aldane', ''), 'prefix');
  assert.equal(resolvesAlone('prefix'), true);
});

test('a term found INSIDE a longer name does not resolve alone', () => {
  // The Vela case, exactly.
  const m = matchOf('Vela', 'Ignatius Marvelance', 'Ignatius', 'Marvelance', '');
  assert.equal(m, 'contains');
  assert.equal(resolvesAlone(m), false, 'must ask, not assume');
});

test('a surname prefix still resolves', () => {
  assert.equal(matchOf('Marv', 'Ignatius Marvelance', 'Ignatius', 'Marvelance', ''), 'prefix');
});

test('matching the EMPLOYER names a room, not a person', () => {
  const m = matchOf('Fernpoint', 'Corwin Ashby', 'Corwin', 'Ashby', 'Fernpoint AI');
  assert.equal(m, 'company');
  assert.equal(resolvesAlone(m), false);
});

test('an exact full name resolves', () => {
  assert.equal(matchOf('Rowan Achterberg', 'Rowan Achterberg', 'Rowan', 'Achterberg', ''), 'exact');
});
