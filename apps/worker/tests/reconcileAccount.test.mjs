// What is true about an account now (GET-1027): a later fact, or a person now on file, retires an
// older claim it settles. Never the reverse, never without a reason, never just for being old.
//
// Run: cd apps/worker && node --test tests/reconcileAccount.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReconcilePrompt, parseRetirements } from '../src/signals/reconcileAccount.mjs';

const claims = [
  { id: 'c1', category: 'authority', content: 'The CEO (not yet named) drives the bot push.', said_at: '2026-10-07' },
  { id: 'c2', category: 'blocker', content: 'Needs API access before anything works.', said_at: '2026-10-08' },
  { id: 'c3', category: 'adoption', content: 'API access has been working since Oct 17.', said_at: '2026-10-21' },
  { id: 'c4', category: 'blocker', content: 'Waiting on beta transcript scope.', said_at: '2026-10-22' },
];

test('the prompt numbers the record oldest first and names the people on file', () => {
  const p = buildReconcilePrompt({ company: 'Arden Motors', today: '2026-10-24', claims,
    people: [{ name: 'Nell Arden', title: 'Founder & CEO', isNew: true }] });
  assert.match(p, /1\. \[2026-10-07\] \[authority\] The CEO \(not yet named\)/);
  assert.match(p, /4\. \[2026-10-22\] \[blocker\] Waiting on beta/);
  assert.match(p, /- Nell Arden, Founder & CEO \(NEW on file\)/);
  assert.match(p, /Never retire an entry because it is old/);
});

test('a later fact retires what it settles, linked; the people on file can too', () => {
  const out = parseRetirements([
    { retire: 2, by: 3, why: 'Access works since Oct 17' },
    { retire: 1, by: null, why: 'Nell Arden is the CEO, on file' },
  ], claims);
  assert.deepEqual(out, [
    { id: 'c2', by: 'c3', why: 'Access works since Oct 17' },
    { id: 'c1', by: null, why: 'Nell Arden is the CEO, on file' },
  ]);
});

test('an earlier fact never retires a later one, and a bare or unknown answer is dropped', () => {
  assert.deepEqual(parseRetirements([
    { retire: 4, by: 2, why: 'older settles newer' },
    { retire: 3, by: 3, why: 'itself' },
    { retire: 9, by: null, why: 'no such entry' },
    { retire: 2, by: 3 },
    { retire: 'x' },
  ], claims), []);
  assert.deepEqual(parseRetirements('not an array', claims), []);
});

test('an entry is retired once, by the first answer about it', () => {
  const out = parseRetirements([{ retire: 2, by: 3, why: 'first' }, { retire: 2, by: 4, why: 'second' }], claims);
  assert.deepEqual(out, [{ id: 'c2', by: 'c3', why: 'first' }]);
});

test('nightly, only something NEW settles an older claim, and a NEW claim is never retired', () => {
  const night = claims.map(c => ({ ...c, isNew: c.id === 'c3' }));
  const answer = [
    { retire: 2, by: 3, why: 'Access works since Oct 17' },        // NEW settles older: kept
    { retire: 2, by: 4, why: 'dup' },
    { retire: 1, by: 2, why: 'old settles old' },                   // not NEW: dropped
    { retire: 3, by: 4, why: 'a NEW claim' },                        // NEW is never retired here
    { retire: 1, by: null, why: 'Nell Arden is the CEO' },           // no new person: dropped
  ];
  assert.deepEqual(parseRetirements(answer, night, { incremental: true, newPeople: false }),
    [{ id: 'c2', by: 'c3', why: 'Access works since Oct 17' }]);
  assert.deepEqual(parseRetirements([{ retire: 1, by: null, why: 'Nell Arden is the CEO' }], night, { incremental: true, newPeople: true }),
    [{ id: 'c1', by: null, why: 'Nell Arden is the CEO' }]);
});

test('the nightly prompt says only NEW items settle anything', () => {
  const p = buildReconcilePrompt({ company: 'Arden Motors', today: '2026-10-24', incremental: true,
    claims: claims.map(c => ({ ...c, isNew: c.id === 'c3' })), people: [] });
  assert.match(p, /3\. NEW \[2026-10-21\] \[adoption\]/);
  assert.match(p, /Only an entry marked NEW, or a person marked NEW, can settle/);
});
