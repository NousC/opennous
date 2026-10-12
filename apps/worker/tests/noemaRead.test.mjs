// A Read returns a RESULT, never a bare value.
//
// Of ~20 extraction sites, two recorded a durable event when a model returned garbage. The rest
// returned `[]`, `null`, or a bare `return` — indistinguishable from "the model read this and found
// nothing". So a whole class of failure was invisible: a commitment the model DID find could vanish
// and look exactly like a message that asked for nothing.
//
// These tests pin the one distinction the layer exists to make: FAILED and EMPTY are different
// answers, and the accept predicate agrees with the parser rather than being written twice.
//
// Run: node --test apps/worker/tests/noemaRead.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArray, parseObject, parseProse, acceptsArray, acceptsObject, acceptsProse, keyedArray } from '../src/noema/read.mjs';

test('an empty array is a real answer, not a failure', () => {
  // The model read the text and found nothing. That is information, and must not be thrown away.
  assert.deepEqual(parseArray('[]'), []);
  assert.equal(acceptsArray('[]'), true);
});

test('an unreadable answer is null — distinct from empty', () => {
  assert.equal(parseArray('I could not find any relationships here.'), null);
  assert.equal(parseArray(''), null);
  assert.equal(parseArray(null), null);
  assert.equal(parseArray('[{"name":"Ambrose"'), null);       // cut off mid-answer
  assert.equal(parseArray('{"name":"Ambrose"}'), null);        // an object where an array was asked for
});

test('reasoning before the answer is fine — both extraction models think out loud', () => {
  const t = 'Let me look at each fact.\n\nFact 1 names Wilhelmina…\n\n[{"name":"Wilhelmina","role":"champion"}]';
  assert.deepEqual(parseArray(t), [{ name: 'Wilhelmina', role: 'champion' }]);
  assert.equal(acceptsArray(t), true);
});

test('the accept predicate and the parser always agree', () => {
  // Written twice, they drift; and when they drift, a correct answer is rejected, re-asked of the
  // dearer model, rejected again, and used anyway — which cost a real slice of a backfill run.
  for (const t of ['[]', '[{"a":1}]', 'prose', '', '[{"a":1}', '{"a":1}', 'reasoning… [1,2]']) {
    assert.equal(acceptsArray(t), parseArray(t) !== null, `disagreed on: ${JSON.stringify(t)}`);
    assert.equal(acceptsObject(t), parseObject(t) !== null, `disagreed on: ${JSON.stringify(t)}`);
  }
});

test('objects follow the same rule', () => {
  assert.deepEqual(parseObject('{"standing":"positive"}'), { standing: 'positive' });
  assert.equal(parseObject('[1,2]'), null);          // an array where an object was asked for
  assert.equal(parseObject('{"standing":'), null);
  assert.equal(acceptsObject('{"standing":"positive"}'), true);
});

test('the labels array IS the answer — an object without one is unreadable, an empty one is not', () => {
  // objection coaching and value-prop resonance both ask for {"labels":[…]}. A bare {} tells us
  // nothing about any of the pairs we sent, so it is a failure; {"labels":[]} is the model saying
  // it read them and matched none, which is a real (and much rarer) answer.
  const { parse, accept } = keyedArray('labels');
  assert.deepEqual(parse('{"labels":[]}'), []);
  assert.deepEqual(parse('{"labels":[{"i":0,"approach":"roi_proof"}]}'), [{ i: 0, approach: 'roi_proof' }]);
  assert.equal(parse('{}'), null);
  assert.equal(parse('{"labels":"roi_proof"}'), null);   // right key, wrong shape
  assert.equal(parse('I labelled six of the pairs.'), null);
  for (const t of ['{"labels":[]}', '{}', '{"labels":[{"i":0}]}', '{"labels":3}', 'prose', '']) {
    assert.equal(accept(t), parse(t) !== null, `disagreed on: ${JSON.stringify(t)}`);
  }
});

test('a prose Read fails only when there is no answer at all', () => {
  // A memory summary has no shape to check, so the only unusable answer is an empty one — and that
  // used to end as a contact silently keeping its old summary.
  assert.equal(parseProse('Acme is mid-funnel; the security review is the blocker.'),
    'Acme is mid-funnel; the security review is the blocker.');
  assert.equal(parseProse('  spaced  '), 'spaced');
  assert.equal(parseProse(''), null);
  assert.equal(parseProse('   \n '), null);
  assert.equal(parseProse(null), null);
  for (const t of ['a summary', '', '   ', null]) {
    assert.equal(acceptsProse(t), parseProse(t) !== null, `disagreed on: ${JSON.stringify(t)}`);
  }
});

test('a Read without an accept is refused at the door', async () => {
  // Not a nicety: the three Reads that shipped without one are exactly the three whose failures
  // vanished without a log line.
  const { read } = await import('../src/noema/read.mjs');
  await assert.rejects(
    () => read({ feature: 'test-read', prompt: 'x', parse: parseArray }),
    /must declare what it accepts/,
  );
});
