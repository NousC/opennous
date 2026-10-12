// GET-392: the buying committee for one account.
//
// The shape that drove this, on Harborline before it was built: a couple of hundred accounts carry
// at least one extracted role, but only a handful have two or more — so a graph of role-bearing
// people alone is a single node for most accounts. Those same accounts average about twenty
// people and one has close to a thousand, which is why ranking and a cap are the feature, not decoration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCommittee, committeeEdges, ROLE_EDGES, ORG_EDGES, COMMITTEE_CAP } from '../src/lib/committee.mjs';

const person = (id, name, lastActivityAt = null) => ({ id, name, jobTitle: null, lastActivityAt });
const roles = (pairs) => new Map(pairs.map(([id, ...rs]) => [id, new Set(rs)]));

test('a role beats a deal, and a deal beats recency', () => {
  const { people } = rankCommittee(
    [person('p1', 'Recent', '2026-09-20'), person('p2', 'Stakeholder'), person('p3', 'Champion')],
    roles([['p3', 'CHAMPIONS']]),
    new Set(['p2']),
  );
  assert.deepEqual(people.map(p => p.id), ['p3', 'p2', 'p1'],
    'the committee is who we labelled, then who is on the deal, then the rest by recency');
});

test('a blocker outranks a decision maker', () => {
  // The one that loses the deal goes first. A rep scanning this needs the bad news at the top.
  const { people } = rankCommittee(
    [person('dm', 'Decider'), person('bl', 'Blocker')],
    roles([['dm', 'DECISION_MAKER_AT'], ['bl', 'BLOCKS']]),
    new Set(),
  );
  assert.deepEqual(people.map(p => p.id), ['bl', 'dm']);
});

test('a person carrying two roles is described by the louder one', () => {
  const { people } = rankCommittee(
    [person('p1', 'Both')], roles([['p1', 'EVALUATING', 'BLOCKS']]), new Set());
  assert.equal(people[0].roles[0], 'BLOCKS');
  assert.equal(people[0].roles.length, 2, 'the quieter role is kept, just not first');
});

test('the rest of the account is ordered newest first', () => {
  const { people } = rankCommittee(
    [person('old', 'Old', '2025-01-01'), person('new', 'New', '2026-09-01'), person('never', 'Never')],
    new Map(), new Set());
  assert.deepEqual(people.map(p => p.id), ['new', 'old', 'never'], 'never-spoken-to is not recent');
});

test('the same account draws the same picture twice', () => {
  // Ties break on name. A graph that reshuffles on reload cannot be read.
  const input = [person('b', 'Bravo'), person('a', 'Alpha'), person('c', 'Charlie')];
  const first = rankCommittee(input, new Map(), new Set()).people.map(p => p.id);
  const second = rankCommittee([...input].reverse(), new Map(), new Set()).people.map(p => p.id);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ['a', 'b', 'c']);
});

test('900 people become 25, and it says so', () => {
  const many = Array.from({ length: 900 }, (_, i) => person(`p${i}`, `P${i}`));
  const out = rankCommittee(many, new Map(), new Set());
  assert.equal(out.people.length, COMMITTEE_CAP);
  assert.equal(out.shown, COMMITTEE_CAP);
  assert.equal(out.total, 900, 'the caller must be able to say what is hidden');
});

test('a role-bearing person survives the cap however quiet they are', () => {
  const many = Array.from({ length: 100 }, (_, i) => person(`p${i}`, `P${i}`, '2026-09-20'));
  many.push(person('quiet', 'Quiet Blocker'));
  const out = rankCommittee(many, roles([['quiet', 'BLOCKS']]), new Set());
  assert.equal(out.people[0].id, 'quiet',
    'the whole point is that the labelled people cannot be crowded out by noise');
});

test('a line to somebody off-screen is dropped, not drawn to nothing', () => {
  const visible = new Set(['a', 'b']);
  const out = committeeEdges([
    { subject_id: 'a', object_id: 'b', relationship: 'REPORTS_TO' },
    { subject_id: 'a', object_id: 'ghost', relationship: 'REPORTS_TO' },
    { subject_id: 'a', object_id: 'a', relationship: 'REPORTS_TO' },
    { subject_id: 'a', object_id: 'b', relationship: 'REPORTS_TO' },
    { subject_id: 'a', object_id: 'b', relationship: 'CHAMPIONS' },
  ], visible);
  assert.deepEqual(out, [{ from: 'a', to: 'b', type: 'REPORTS_TO' }],
    'off-screen dropped, self-edge dropped, duplicate collapsed, badge is not a line');
});

test('roles are badges and org edges are lines, and they do not overlap', () => {
  for (const r of ROLE_EDGES) assert.equal(ORG_EDGES.has(r), false, `${r} cannot be both`);
  // Role edges point at a company; drawing them would be twenty lines to the same dot.
  assert.ok(ROLE_EDGES.has('DECISION_MAKER_AT') && ORG_EDGES.has('REPORTS_TO'));
});
