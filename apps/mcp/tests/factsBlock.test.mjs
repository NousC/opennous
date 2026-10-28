// get_context / get_account print the current position first, and every fact says when it was
// said and whether it still holds (GET-770). An agent reading "needs another couple of months"
// with no date beside it has no way to know a later call replaced it.
//
// Run: node --test apps/mcp/tests/factsBlock.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factsBlock } from '../src/server.js';

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

test('CURRENT POSITION leads, then the facts, each dated and marked when it may no longer hold', () => {
  const lines = factsBlock({
    current_position: [{ category: 'buying_signal', content: 'Dana Reyes wants to present Nous to the other stakeholders.', date: daysAgo(1), freshness: 'fresh' }],
    facts: [
      { category: 'buying_signal', content: 'Dana Reyes wants to present Nous to the other stakeholders.', date: daysAgo(1), freshness: 'fresh' },
      { category: 'goal', content: 'Dana Reyes needs the turnaround for a couple of months.', date: daysAgo(20), freshness: 'aging' },
    ],
    meta: { facts_total: 2 },
  });
  const text = lines.join('\n');
  assert.ok(text.indexOf('CURRENT POSITION') < text.indexOf('FACTS'), 'current position first');
  assert.match(text, /\[buying_signal\] Dana Reyes wants to present Nous to the other stakeholders\.\s+\(said \w{3} \d{1,2} · 1d ago\)/);
  assert.match(text, /couple of months\.\s+\(said \w{3} \d{1,2} · 20d ago · aging\)/);
});

test('no current position, no empty section; old payloads without freshness still render', () => {
  const lines = factsBlock({ facts: [{ category: 'pain', content: 'X finds reporting slow.', date: daysAgo(3) }] });
  const text = lines.join('\n');
  assert.doesNotMatch(text, /CURRENT POSITION/);
  assert.match(text, /\[pain\] X finds reporting slow\.\s+\(said \w{3} \d{1,2} · 3d ago\)/);
  assert.deepEqual(factsBlock({ facts: [] }), []);
});

// GET-798: the deal position groups every open blocker under one heading, the stack prints one
// line per tool, and what a newer claim replaced reads old → new, all before FACTS.
test('sections in order: CURRENT POSITION (blockers grouped), TECH STACK, RECENTLY REPLACED, FACTS', () => {
  const lines = factsBlock({
    current_position: [
      { category: 'buying_signal', content: 'Dana Reyes wants to present Nous to the other stakeholders.', date: daysAgo(1), freshness: 'fresh' },
      { category: 'blocker', content: 'Security review is pending.', date: daysAgo(2), freshness: 'fresh', status: 'open' },
      { category: 'requirement', content: 'Acme needs SSO.', date: daysAgo(5), freshness: 'fresh' },
      { category: 'blocker', content: 'Legal has not signed the DPA.', date: daysAgo(4), freshness: 'fresh', status: 'open' },
    ],
    tech_stack: [
      { tool: 'HubSpot', summary: 'Acme moved its pipeline into HubSpot.', facts: [{ category: 'tech_stack', content: 'Acme moved its pipeline into HubSpot.', date: daysAgo(2), freshness: 'fresh' }] },
      { tool: 'RingCentral', summary: 'Acme dials through RingCentral.', facts: [{ category: 'tech_stack', content: 'Acme dials through RingCentral.', date: daysAgo(8), freshness: 'fresh' }] },
    ],
    recently_replaced: [{
      old: { category: 'timeline', content: 'Dana Reyes needs another couple of months.', said_at: daysAgo(9) },
      new: { category: 'buying_signal', content: 'Dana Reyes wants to present Nous to the other stakeholders.', said_at: daysAgo(1) },
    }],
    facts: [{ category: 'status_quo', content: 'Dana Reyes routes leads by hand today.', date: daysAgo(1), freshness: 'fresh', speaker: 'Dana Reyes', quote: 'we do it by hand', source: 'fellow' }],
    facts_total: 1,
  });
  const text = lines.join('\n');
  const at = (s) => text.indexOf(s);
  assert.ok(at('CURRENT POSITION') >= 0 && at('CURRENT POSITION') < at('TECH STACK'));
  assert.ok(at('TECH STACK') < at('RECENTLY REPLACED') && at('RECENTLY REPLACED') < at('FACTS'));
  assert.equal(text.match(/Blockers \(open\):/g).length, 1, 'one blockers heading');
  assert.match(text, /Blockers \(open\):\n    - Security review is pending\.\s+\(said \w{3} \d{1,2} · 2d ago\)\n    - Legal has not signed the DPA\./);
  assert.match(text, /Requirements:\n    - Acme needs SSO\./);
  assert.match(text, /  HubSpot — Acme moved its pipeline into HubSpot\.\s+\(said \w{3} \d{1,2} · 2d ago\)/);
  assert.match(text, /  RingCentral — Acme dials through RingCentral\./);
  assert.match(text, /\w{3} \d{1,2} \[timeline\] 'Dana Reyes needs another couple of months\.' → \w{3} \d{1,2} \[buying_signal\] 'Dana Reyes wants to present Nous/);
  assert.match(text, /\[status_quo\] Dana Reyes routes leads by hand today\./);
  assert.match(text, /Dana Reyes · "we do it by hand"/, 'facts keep their evidence lines');
});

test('a payload with only facts (older callers) renders just FACTS', () => {
  const text = factsBlock({ facts: [{ category: 'pain', content: 'Reporting is slow.', date: daysAgo(3) }], tech_stack: [], recently_replaced: [] }).join('\n');
  assert.doesNotMatch(text, /TECH STACK|RECENTLY REPLACED|CURRENT POSITION/);
  assert.match(text, /FACTS \(1/);
});

test('an event says when it happened beside when it was said (GET-1051)', () => {
  const lines = factsBlock({
    facts: [
      { category: 'tech_stack', content: 'Brindle moved off Marrowdesk in March 2026.', date: daysAgo(3), freshness: 'fresh', occurred: '2026-03-01 to 2026-03-31' },
      { category: 'firmographic', content: 'Brindle has forty account executives.', date: daysAgo(3), freshness: 'fresh' },
    ],
  }).join('\n');
  assert.match(lines, /moved off Marrowdesk in March 2026\.\s+\(said [A-Z][a-z]{2} \d+ · [^)]*· happened 2026-03-01 to 2026-03-31\)/);
  assert.match(lines, /forty account executives\.\s+\(said [^)]*\)/);
  assert.doesNotMatch(lines.split('\n').find(l => l.includes('forty')), /happened/);
});
