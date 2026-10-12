// get_context leads with the current position, dated, and says how fresh each fact is (GET-770).
// Before: the newest 15 facts by WRITE time, no freshness, no notion of what is current — so a
// re-extraction of September dated it today and a call two weeks old read as this week's news.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/contextCurrentFirst.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeContextFacts } from '../dist/db/claimTime.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();
const fact = (category, content, date) => ({ category, content, date });

// GET-798: current_position is the DEAL's topics only (a goal is not one), and `facts` no longer
// repeats what current_position shows.
test('facts carry freshness and come current-first; current_position holds one per open deal topic', () => {
  const { facts, current_position } = shapeContextFacts([
    fact('firmographic', 'Acme has ~400 live customers.', daysAgo(25)),
    fact('buying_signal', 'Dana Reyes wants to present Nous to the other stakeholders.', daysAgo(1)),
    fact('buying_signal', 'Dana Reyes asked for the DPA.', daysAgo(24)),
    fact('goal', 'Dana Reyes wants daily stats in Slack.', daysAgo(1)),
  ], { now: NOW, cap: 15 });
  assert.equal(facts[0].content, 'Dana Reyes wants daily stats in Slack.');
  assert.ok(facts.every(f => ['fresh', 'aging', 'suspect', 'expired'].includes(f.freshness)));
  assert.ok(!facts.some(f => f.content === 'Dana Reyes wants to present Nous to the other stakeholders.'));
  assert.deepEqual(current_position.map(f => f.category), ['buying_signal']);
  assert.equal(current_position[0].content, 'Dana Reyes wants to present Nous to the other stakeholders.');
});

test('the cap keeps the current facts, not merely the last ones written', () => {
  const many = Array.from({ length: 30 }, (_, i) => fact('preference', `Old preference ${i}.`, daysAgo(200 + i)));
  const { facts, total } = shapeContextFacts([...many, fact('goal', 'Wants daily stats in Slack.', daysAgo(2))], { now: NOW, cap: 15 });
  assert.equal(facts.length, 15);
  assert.equal(total, 31);
  assert.equal(facts[0].content, 'Wants daily stats in Slack.');
});
