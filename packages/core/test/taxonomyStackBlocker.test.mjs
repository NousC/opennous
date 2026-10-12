// Three categories a rep reads by, and the routing that keeps account facts on the account (GET-776).
//
// tech_stack: the tools they run, on the COMPANY, one topic per tool — scattered before across
//   status_quo, competitor and even risk_signal ("blocked the prod DB from the AI bot" is a fact
//   about their AI bot, not a risk to us).
// blocker: what stands between now and a signed deal, open or resolved.
// requirement: a hard condition for buying ("must create the tasks in HubSpot or this doesn't make sense").
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/taxonomyStackBlocker.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_CATEGORY_KEYS, ACCOUNT_ROLLUP_CATEGORIES, claimSubtagsFor, claimFreeTextFor, claimDomainOf,
  claimAboutFor, isIntelClaim, claimCategoryPromptBlock,
} from '../dist/db/claimCategories.js';
import { isTimeBound, halfLifeDays } from '../dist/db/claimTime.js';
import { buildIntelTopicsPrompt } from '../dist/db/intelTopics.js';

test('the three categories exist, in the right domains, and roll up to the account', () => {
  for (const k of ['tech_stack', 'blocker', 'requirement']) {
    assert.ok(CLAIM_CATEGORY_KEYS.includes(k), k);
    assert.ok(ACCOUNT_ROLLUP_CATEGORIES.includes(k), `${k} rolls up`);
  }
  assert.equal(claimDomainOf('blocker'), 'deal');
  assert.equal(claimDomainOf('requirement'), 'deal');
  assert.equal(claimDomainOf('tech_stack'), 'account');
  const block = claimCategoryPromptBlock();
  assert.match(block, /tech_stack/); assert.match(block, /blocker/); assert.match(block, /requirement/);
  // status_quo no longer competes for tools.
  assert.match(block, /status_quo — [^\n]*NOT the tools/i);
});

test('a blocker carries open/resolved; a tech_stack fact names its tool', () => {
  assert.deepEqual(claimSubtagsFor('blocker', { status: 'resolved' }), { status: 'resolved' });
  assert.deepEqual(claimSubtagsFor('blocker', { status: 'whatever' }), { status: null }, 'outside the set is no status, stored as null like every subtag');
  assert.deepEqual(claimFreeTextFor('tech_stack', { tool: '  GrokBot ' }), { tool: 'GrokBot' });
});

test('company categories are filed on the company whatever the model tagged', () => {
  for (const k of ['tech_stack', 'firmographic', 'performance', 'seasonality']) assert.equal(claimAboutFor(k, 'person'), 'company', k);
  assert.equal(claimAboutFor('pain', 'person'), 'person');
  assert.equal(claimAboutFor('blocker', 'company'), 'company');
});

test('they age and get replaced like the other positions', () => {
  for (const k of ['tech_stack', 'blocker', 'requirement']) assert.ok(isTimeBound(k), k);
  assert.ok(halfLifeDays('blocker') < halfLifeDays('tech_stack'));
});

test('a transcript or meeting-notes dump is bookkeeping, never intel', () => {
  assert.equal(isIntelClaim({ category: 'general', content: '———— Transcript ————\n\nDana: hello', source: 'fellow', metadata: {} }), false);
  assert.equal(isIntelClaim({ category: 'general', content: '# Product Demo and Workspace Updates\n\n- Major updates since last call', source: 'granola', metadata: {} }), false);
  assert.equal(isIntelClaim({ category: 'pain', content: 'Dana Reyes says prospecting is manual.', source: 'signal_extraction', metadata: {} }), true);
});

test('a topic never mixes groups, and the tech stack is one topic per tool', () => {
  const p = buildIntelTopicsPrompt([{ id: 'a', category: 'tech_stack', content: 'Acme runs GrokBot.', created_at: '2026-10-07T00:00:00Z' }]);
  assert.match(p, /never mixes/i);
  assert.match(p, /one topic per tool/i);
  assert.doesNotMatch(p, /belong together even when their categories differ/);
});
