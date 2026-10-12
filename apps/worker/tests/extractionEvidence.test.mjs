// The evidence pair, and the bar that decides whose record a fact belongs on.
//
// Two gaps this pins, both measured on a customer corpus:
//
//   speaker — the worker asked the model for a `quote` and never for a `speaker`, while the
//   plugin's write path asked for both. So every claim the platform extracted itself carried a
//   checkable line and an anonymous one. In a review call with eight attendees that is half an
//   answer: a claim about the GM resting on a line a junior rep spoke means something else.
//
//   ABOUT THEM — the rule existed as prose and as a Rules bullet, never as one of the numbered
//   bars, so it never got the "passes ALL" gating. The platform filed far fewer Fellow claims on
//   the company than a careful hand did, and the commonest error in the corpus is a fact about our
//   own product or roadmap filed as a fact about the customer.
//
// Run: node --test apps/worker/tests/extractionEvidence.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildActivitySignalsPrompt, buildMeetingSignalsPrompt } from '../src/signals/index.mjs';

// The two builders do not return the same shape: the activity one returns
// { prompt, maxFacts, maxTokens }, the meeting one returns the string. Unwrap both so the
// assertions below read the text either way.
const text = r => (typeof r === 'string' ? r : r.prompt);

const activity = () => text(buildActivitySignalsPrompt({
  contactName: 'Rennick Aldous', company: 'Pellham Ford', type: 'meeting_held', summary: 'a call',
}));
const meeting = () => text(buildMeetingSignalsPrompt({
  attendees: [{ name: 'Rennick Aldous', email: 'raldous@pellhamford.example' }],
  transcript: 'a transcript', ourSide: null,
}));

// Both prompts are independent copies of the same rules, and every divergence between them has
// been a bug. Anything asserted here is asserted on both.
const BOTH = [['activity', activity], ['meeting', meeting]];

for (const [name, build] of BOTH) {
  test(`${name}: the output schema asks for a speaker`, () => {
    const p = build();
    assert.match(p, /"speaker"/, 'speaker must be in the JSON shape the model is told to return');
  });

  test(`${name}: the speaker field is explained, not just listed`, () => {
    // A key in the schema with no rule beside it gets filled with whatever is nearest — which for
    // a transcript is usually the first label on the page.
    const p = build();
    assert.match(p, /- "speaker":/, 'speaker needs its own rule line');
  });

  test(`${name}: ABOUT THEM is the first numbered bar`, () => {
    const p = build();
    assert.match(p, /ALL FOUR bars/, 'the bar count must include it');
    assert.match(p, /1\. ABOUT THEM/, 'it has to be a numbered bar, not prose');
  });

  test(`${name}: the bar names our product as the thing that fails it`, () => {
    // The failure is not abstract: our roadmap and our pricing take up most of a review call, and
    // filing that as customer intel is the single commonest error in the corpus.
    const p = build();
    assert.match(p, /roadmap|our product|our pricing/i);
  });

  test(`${name}: the two genuine exceptions survive`, () => {
    // Tightening this bar must not delete the objection category or facts our rep states about
    // the customer — both were explicitly kept.
    const p = build();
    assert.match(p, /objection is their reaction/i, 'an objection still belongs to them');
    assert.match(p, /states ABOUT/i, "our rep's statement about them is still their fact");
  });

  test(`${name}: no stale "three bars" wording is left behind`, () => {
    // The count appears in more than one place; a prompt that promises four and then says "all
    // three" teaches the model to ignore one of them.
    const p = build();
    assert.doesNotMatch(p, /ALL THREE bars/);
    assert.doesNotMatch(p, /all three bars/);
  });

  test(`${name}: the durability carve-out names all four exceptions`, () => {
    // Two since GET-372; four since GET-401, when the customer-success snapshots — an expansion
    // ask and a stated risk — got categories of their own instead of riding in on buying_signal
    // and pain. A snapshot the bar does not except is a snapshot the model drops.
    const p = build();
    assert.match(p, /FOUR EXCEPTIONS/);
    assert.match(p, /buying_signal/);
    assert.match(p, /performance/);
    assert.match(p, /expansion_signal/);
    assert.match(p, /risk_signal/);
  });

  test(`${name}: a decline is never left without a stance`, () => {
    // The one failure the CS page cannot ship with, guarded at the prompt as well as the writer
    // and the reader: the miner's first sample returned a decline with no stance at all.
    const p = build();
    assert.match(p, /NEVER (leave|omit) "stance"/);
    assert.match(p, /"stance": "<expansion_signal only>"|"product": "<expansion_signal only>"/);
    assert.match(p, /"severity": "<risk_signal only>"/);
  });
}

test('the bars are numbered 1-4 with no gap or repeat', () => {
  for (const [name, build] of BOTH) {
    const nums = [...build().matchAll(/^(\d)\. [A-Z]/gm)].map(m => Number(m[1]));
    assert.deepEqual(nums, [1, 2, 3, 4], `${name} bars should be 1,2,3,4 — got ${nums.join(',')}`);
  }
});
