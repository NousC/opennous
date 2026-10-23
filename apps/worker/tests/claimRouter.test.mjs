// One home per statement (GET-775). The claim extractor and the insight extractor read the same
// transcript without knowing about each other, so one sentence landed in both: feedback on our
// account summary filed as the customer's "pain", a view about AI agents filed as an "objection".
// The claim extractor now says where each statement belongs, and only claims are filed.
//
// Run: node --test apps/worker/tests/claimRouter.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeFacts, buildActivitySignalsPrompt, buildMeetingSignalsPrompt } from '../src/signals/index.mjs';

const text = r => (typeof r === 'string' ? r : r.prompt);

test('both claim prompts carry the routing rules and ask for a home on every fact', () => {
  for (const p of [
    text(buildActivitySignalsPrompt({ contactName: 'Dana Reyes', type: 'meeting_held', summary: 't' })),
    buildMeetingSignalsPrompt({ roster: '1. Dana Reyes', transcript: 't', maxFacts: 8 }),
  ]) {
    assert.match(p, /WHERE EACH STATEMENT BELONGS/);
    assert.match(p, /"home"/);
    assert.match(p, /our_product/);
    assert.match(p, /market/);
    // The worked examples are the corrections that motivated this.
    assert.match(p, /account summary/i);
    assert.match(p, /confident answers/i);
    assert.match(p, /hard condition for buying/i);
    // GET-1023: "build your own X, get us off the others" was filed as a friction.
    assert.match(p, /build your own recorder and get us off the others" is a feature, not a friction/);
  }
});

test('only claims are filed; product feedback and market views are routed away, and counted', () => {
  const { claims, routed } = routeFacts([
    { content: 'Dana Reyes wants to present Nous to the other stakeholders.', category: 'buying_signal', home: 'claim' },
    { content: 'Dana Reyes wants the account summary to lead with what to know for onboarding.', category: 'preference', home: 'our_product' },
    { content: 'Dana Reyes says agents give confident answers when they do not know.', category: 'objection', home: 'market' },
    { content: 'Dana Reyes uses HubSpot.', category: 'status_quo' },
  ]);
  assert.deepEqual(claims.map(c => c.category), ['buying_signal', 'status_quo'], 'no home given means claim: the old behaviour');
  assert.equal(routed.our_product, 1);
  assert.equal(routed.market, 1);
  assert.ok(claims.every(c => !('home' in c)), 'the routing tag does not travel into storage');
});

test('an unknown home is treated as a claim, never silently dropped', () => {
  const { claims } = routeFacts([{ content: 'x', category: 'pain', home: 'something else' }]);
  assert.equal(claims.length, 1);
});

// GET-776: the extractor is told how to tag the three new categories, and the hard condition for
// buying the router keeps as a claim has a category of its own.
test('both prompts say how to tag tech_stack, blocker and requirement', () => {
  for (const p of [
    text(buildActivitySignalsPrompt({ contactName: 'Dana Reyes', type: 'meeting_held', summary: 't' })),
    buildMeetingSignalsPrompt({ roster: '1. Dana Reyes', transcript: 't', maxFacts: 8 }),
  ]) {
    assert.match(p, /tech_stack[^\n]*"tool"/);
    assert.match(p, /blocker[^\n]*"status"[^\n]*open[^\n]*resolved/);
    assert.match(p, /is a claim, category requirement/);
    assert.match(p, /"tool": "<tech_stack only>"/);
  }
});
