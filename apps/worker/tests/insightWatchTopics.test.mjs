// A watch-topic added in Settings is a keyword for any category (GET-970 follow-up, Phase 0.6).
//
// The Settings form files custom topics as 'general', which is no category. Printed under that raw
// key, the prompt read it as one, and an insight the model filed under 'general' was dropped.
//
// Run: node --test apps/worker/tests/insightWatchTopics.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatWatchTopics } from '@nous/core';

const topic = (category, keyword, source = 'external') => ({ id: keyword, source, category, keyword, enabled: true, is_default: false });

test('a topic with no real category is listed under Any category', () => {
  const out = formatWatchTopics([topic('product', 'Slack'), topic('general', 'SOC 2'), topic('general', 'Product releases')], 'external');
  assert.match(out, /^- Product[^:]*: Slack$/m);
  assert.match(out, /^- Any category: SOC 2, Product releases$/m);
  assert.doesNotMatch(out, /general/);
});

test('a team topic uses the team categories', () => {
  const out = formatWatchTopics([topic('decisions', 'pricing', 'team'), topic('general', 'hiring', 'team')], 'team');
  assert.match(out, /Any category: hiring/);
  assert.doesNotMatch(out, /general/);
});
