// One name per tool, and buying signal / blocker stop counting setup steps (2026-10-08 re-sort of a
// real account: "Grok" and "GrokBot" were two tools; "pushed the NDA through" was a buying signal;
// "gave us access to the dialer" was a blocker).
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/toolNamesAndBars.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToolName, claimFreeTextFor, CLAIM_CATEGORIES } from '../dist/db/claimCategories.js';

test('one canonical name per tool', () => {
  for (const n of ['Grok', 'grok', 'Grokbot', 'GrokBots', 'Grok bots', 'Grok agents']) assert.equal(normalizeToolName(n), 'GrokBot', n);
  assert.equal(normalizeToolName('JustCall AI'), 'JustCall');
  assert.equal(normalizeToolName('Hubspot CRM'), 'HubSpot');
  assert.equal(normalizeToolName('Ring Central'), 'RingCentral');
  assert.equal(normalizeToolName('Open Phone'), 'OpenPhone');
  assert.equal(normalizeToolName('Fellow'), 'Fellow');
  assert.equal(normalizeToolName('  Some New Tool  '), 'Some New Tool', 'unknown tools keep their name, trimmed');
  assert.deepEqual(claimFreeTextFor('tech_stack', { tool: 'grok bots' }), { tool: 'GrokBot' });
});

test('buying signal and blocker say what they are not', () => {
  const d = (k) => CLAIM_CATEGORIES.find(c => c.key === k).description;
  assert.match(d('buying_signal'), /paperwork|NDA/i);
  assert.match(d('buying_signal'), /access|API key/i);
  assert.match(d('blocker'), /setup step|access/i);
});
