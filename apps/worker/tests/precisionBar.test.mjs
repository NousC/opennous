// Precision on long calls (measured on the extraction test set, 2026-10-08): with smaller parts a
// call produced ~25 claims instead of ~15, and the extra ones were the true-but-minor kind a
// reviewer rejects. Three fixes:
//   1. one fact budget per CALL, split across its parts — a long call no longer yields more just
//      because it is read in more pieces;
//   2. a later part is told what earlier parts already found, so it does not find it again;
//   3. the reviewer's bar is in the prompt, with the kinds of fact he rejected.
//
// Run: node --test apps/worker/tests/precisionBar.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perPartFactCap, buildActivitySignalsPrompt, buildMeetingSignalsPrompt } from '../src/signals/index.mjs';

const text = r => (typeof r === 'string' ? r : r.prompt);

test('the fact budget is per call: split across parts, with a small floor', () => {
  assert.equal(perPartFactCap(12, 1), 12);
  assert.equal(perPartFactCap(12, 2), 7);
  assert.equal(perPartFactCap(12, 4), 4);
  assert.equal(perPartFactCap(12, 10), 3, 'a part can still say something');
  // Summed over parts it stays close to the call's budget, never multiples of it.
  assert.ok(perPartFactCap(12, 4) * 4 <= 12 + 4);
});

test('a later part is shown what earlier parts already captured, and told not to repeat it', () => {
  const p = text(buildActivitySignalsPrompt({
    contactName: 'Dana Reyes', type: 'meeting_held', summary: 't',
    part: { index: 1, total: 3, context: null, already: ['Dana Reyes wants daily stats pushed to Slack.', 'Acme runs GrokBot agents.'] },
  }));
  assert.match(p, /ALREADY CAPTURED/);
  assert.match(p, /wants daily stats pushed to Slack/);
  assert.match(p, /do not record them again/i);
  const first = text(buildActivitySignalsPrompt({ contactName: 'Dana Reyes', type: 'meeting_held', summary: 't', part: { index: 0, total: 3, context: null, already: [] } }));
  assert.doesNotMatch(first, /ALREADY CAPTURED/);
  const m = buildMeetingSignalsPrompt({ roster: '1. Dana Reyes', transcript: 't', maxFacts: 8, part: { index: 1, total: 2, context: null, already: ['Acme runs GrokBot agents.'] } });
  assert.match(m, /ALREADY CAPTURED/);
});

test('the bar is in both prompts: only what moves the deal, with the kinds of fact that do not', () => {
  for (const p of [
    text(buildActivitySignalsPrompt({ contactName: 'Dana Reyes', type: 'meeting_held', summary: 't' })),
    buildMeetingSignalsPrompt({ roster: '1. Dana Reyes', transcript: 't', maxFacts: 8 }),
  ]) {
    assert.match(p, /MOVES THE DEAL/);
    assert.match(p, /when in doubt, leave it out/i);
    assert.match(p, /org-chart detail/i);
    assert.match(p, /passing mention/i);
    assert.match(p, /what WE think they pay/i);
  }
});

// The audit of 100 unmatched claims (2026-10-08) named the junk patterns, and the importance rating
// lets the extractor rank rather than hold back: low-importance facts are dropped before filing.
test('the bar names the audited junk patterns', async () => {
  const p = text(buildActivitySignalsPrompt({ contactName: 'Dana Reyes', type: 'meeting_held', summary: 't' }));
  assert.match(p, /their own competitors/i);
  assert.match(p, /stale/i);
  assert.match(p, /vague offer/i);
  assert.match(p, /"importance": "high\|medium\|low"/);
});

test('low-importance facts are not filed, and are counted', async () => {
  const { routeFacts } = await import('../src/signals/index.mjs');
  const { claims, routed } = routeFacts([
    { content: 'a', home: 'claim', importance: 'high' },
    { content: 'b', home: 'claim', importance: 'medium' },
    { content: 'c', home: 'claim', importance: 'low' },
    { content: 'd', home: 'claim' },
  ]);
  assert.deepEqual(claims.map(c => c.content), ['a', 'b', 'd'], 'no importance given means kept');
  assert.equal(routed.low_importance, 1);
  assert.ok(claims.every(c => !('importance' in c)));
});

// The per-call budget alone cut too deep on long calls (2026-10-08: precision 55% → 73–79%, but
// capture 68–70% → 53–57%): a 50,000-character meeting got 12 facts across 4 parts. It now grows a
// little with length — 3 per extra part, at most 8 more — so short calls stay tight.
test('the call budget grows a little with length, capped', async () => {
  const { callFactBudget } = await import('../src/signals/index.mjs');
  assert.equal(callFactBudget(12, 1), 12);
  assert.equal(callFactBudget(12, 2), 15);
  assert.equal(callFactBudget(12, 4), 20);
  assert.equal(callFactBudget(12, 9), 20, 'never more than 8 above the base');
  assert.equal(callFactBudget(4, 3), 10);
});
