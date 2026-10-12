// What counts as a usable answer depends on the question.
//
// One gate served three different prompts, and demanded a `call_type` field. A health read returns
// standing, risks and expansion signals and never mentions a call type — so every business review
// and training call in a backfill was answered correctly by DeepSeek, REJECTED,
// re-asked of GLM 5.2 with the same 60,000-character transcript, rejected again, logged as
// LLM_FALLBACK_EXHAUSTED, and then used anyway.
//
// The pages were always right. We paid twice for each of them, on the model that costs ~3x more —
// a large share of the call-scoring calls in a run, and a real slice of the bill, buying nothing — and the
// logs reported a failure on every CS call, which hid whether scoring was really broken.
//
// Run: node --test apps/worker/tests/acceptGate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usableHealthRead } from '../src/signals/callScore.mjs';
import { buildHealthReadPrompt } from '@nous/core';

// A health read, in the shape accountHealth.ts asks for.
const HEALTH = '{"summary":"They are live on the new portal.","what_changed":"Two new users.",'
  + '"adoption":"Daily use by the sales desk.","standing":"positive",'
  + '"risks":[{"text":"Sponsor leaving","quote":"I am moving on in the spring"}],'
  + '"expansion":[],"commitments":[]}';

test('a health read is accepted by its own gate', () => {
  assert.equal(usableHealthRead(HEALTH), true);
});

test('a health read would have FAILED the review gate — the bug, pinned', () => {
  const reviewGate = (text) => /\{[\s\S]*"call_type"[\s\S]*\}/.test(String(text ?? ''));
  assert.equal(reviewGate(HEALTH), false);   // correct answer, rejected, re-asked, paid for twice
});

test('reasoning before the JSON is still accepted', () => {
  // Both extraction models think out loud before answering; the gate must not punish that.
  assert.equal(usableHealthRead(`Let me work through the transcript…\n\n${HEALTH}`), true);
});

test('an empty, cut-off or prose answer is refused, so the fallback is used for a real reason', () => {
  assert.equal(usableHealthRead(''), false);
  assert.equal(usableHealthRead(null), false);
  assert.equal(usableHealthRead('The account seems fine overall.'), false);
  assert.equal(usableHealthRead('{"summary":"cut off here'), false);
});

test('the prompt really does ask for the field the gate looks for', () => {
  // The gate and the prompt must agree, or this bug comes back wearing different clothes.
  const prompt = buildHealthReadPrompt('a transcript', { title: 'QBR', callType: 'business_review', people: [] });
  assert.match(prompt, /"standing"/);
});
