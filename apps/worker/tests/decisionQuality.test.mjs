// The rules the engine is willing to put in front of an agent. These lock the floors: a
// pattern that is not lopsided enough, or not sampled enough, produces no sentence at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulesFor } from '../src/intelligence/jobs/decisionQuality.mjs';

const counts = (over = {}) => ({ total: 100, rejected: 0, confirmed: 100, unconfirmed: 0, verified: 100, verified_edited: 0, ...over });

test('a heavily rewritten category earns a rule', () => {
  const r = rulesFor('outreach', counts({ verified_edited: 70 }));
  assert.equal(r.length, 1);
  assert.equal(r[0].shape, 'rewrite');
  assert.match(r[0].text, /70%/);
  assert.match(r[0].text, /outreach recommendations/);
});

test('rewrites are measured only over decisions we could actually check', () => {
  // 100 decisions, only 4 with a drafted body to compare. Three of those were rewritten — a
  // 75% rate on n=4. It must not reach the agent as "your drafts get rewritten".
  const r = rulesFor('outreach', counts({ verified: 4, verified_edited: 3 }));
  assert.equal(r.filter((x) => x.shape === 'rewrite').length, 0);
});

test('a mild pattern is not worth a line of the agent context', () => {
  assert.equal(rulesFor('outreach', counts({ verified_edited: 20 })).length, 0);
});

test('turned-down advice is a different rule from rewritten advice', () => {
  const r = rulesFor('outreach', counts({ rejected: 40 }));
  assert.equal(r.length, 1);
  assert.equal(r[0].shape, 'reject');
  assert.match(r[0].text, /angle is landing wrong/);
});

test('advice agreed to and never done produces the drop-off rule', () => {
  const r = rulesFor('follow_up', counts({ confirmed: 50, unconfirmed: 50 }));
  const drop = r.find((x) => x.shape === 'dropoff');
  assert.ok(drop);
  assert.equal(drop.n, 100, 'the denominator is what was agreed, not everything proposed');
  assert.match(drop.text, /smaller thing/);
});

test('a thin category produces nothing at all', () => {
  assert.deepEqual(rulesFor('outreach', counts({ total: 10, verified: 10, verified_edited: 9, rejected: 9, confirmed: 5, unconfirmed: 5 })), []);
});
