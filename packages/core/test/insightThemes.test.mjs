// A theme is a durable object, and a pattern is measured in conversations (2026-09-20).
//
// Two bugs sat behind the Insights tab. The first: themes were a disposable cache —
// membership lived in an array, the cache key was a hash of every insight id, and a rebuild
// deleted every theme and re-inserted it with a new uuid. reporting_insight_state keys
// status and notes BY THAT UUID, so every rebuild orphaned every status; measured on the
// live DB, every status row was an orphan. The second: a theme's weight was its
// row count, so a demo workspace's themes — all mined from a SINGLE seeded call — each
// announced a dozen-plus "mentions" as though that were a trend.
//
// These tests pin the invariants, not the wording of a prompt.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/insightThemes.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildThemeRoutingPrompt, buildThemeClusterPrompt, buildThemeMergePrompt, parseThemeJson,
  THEMES_PER_CATEGORY, CLUSTER_CHUNK,
} from '../dist/db/insights.js';
import { INSIGHT_CATEGORY_KEYS } from '../dist/db/insightCategories.js';

// ── The category is an INPUT to clustering, never an output ──────────────────
// Clustering used to run across all four categories at once and let the model re-label
// each theme's category, overriding the value the extractor had already validated. That is
// how "personalized video outperforms generic AI messaging" ended up filed under Product.

test('the cluster prompt names one category and never asks the model to choose one', () => {
  const p = buildThemeClusterPrompt('Market', 'customer', ['a', 'b', 'c'], 9);
  assert.match(p, /"Market" insights/);
  // The old prompt carried `"category": one of: product, positioning, market, buyer`.
  for (const k of INSIGHT_CATEGORY_KEYS) {
    assert.ok(!p.includes(`"category":"${k}"`), `prompt must not ask for a category (${k})`);
  }
  assert.ok(!/"category"/.test(p), 'category is an input now, not a field the model returns');
});

test('a category budget is per category, not shared across all four', () => {
  // The old cap was 12 for the whole workspace, so one category could eat it: Fernpoint's
  // Market tab held ONE theme covering dozens of insights from many separate calls.
  assert.ok(THEMES_PER_CATEGORY >= 6 && THEMES_PER_CATEGORY <= 12);
  const p = buildThemeClusterPrompt('Product', 'customer', ['x', 'y'], THEMES_PER_CATEGORY);
  assert.match(p, new RegExp(`AT MOST ${THEMES_PER_CATEGORY} recurring THEMES`));
});

test('clustering refuses a theme of one, and says the leftovers are kept', () => {
  const p = buildThemeClusterPrompt('Buyer', 'customer', ['x'], 9);
  assert.match(p, /at least 2 insights/i);
  // A model that believes omitting something loses it will pad. It must know otherwise.
  assert.match(p, /unassigned insights are kept/i);
});

// ── Routing must be allowed to say "none of these" ───────────────────────────
// A router that always finds a home hides the thing that was new — the single failure
// mode that matters here, because it is invisible on the page.

test('the routing prompt offers an explicit no-match answer', () => {
  const p = buildThemeRoutingPrompt(
    [{ title: 'Buyers want proof of ROI', takeaway: 'Lead with a number.' }],
    ['they asked for a case study'],
  );
  assert.match(p, /-1/);
  assert.match(p, /hides the very thing that was new|hides the thing that was new/i);
});

test('the routing prompt shows every existing theme, so nothing is invisible to it', () => {
  const themes = [
    { title: 'Alpha pattern', takeaway: 'do alpha' },
    { title: 'Beta pattern', takeaway: null },
  ];
  const p = buildThemeRoutingPrompt(themes, ['one', 'two', 'three']);
  assert.match(p, /0\. Alpha pattern — do alpha/);
  assert.match(p, /1\. Beta pattern/);
  // Indices the caller will map back must be 0-based and complete.
  assert.match(p, /0\. one/);
  assert.match(p, /2\. three/);
});

test('a takeaway-less theme does not produce a dangling separator', () => {
  const p = buildThemeRoutingPrompt([{ title: 'Beta pattern', takeaway: null }], ['x']);
  assert.ok(!p.includes('Beta pattern — \n'), 'no empty em-dash tail');
});

// ── Chunking: a 500-insight category has to be tractable ─────────────────────

test('the chunk size keeps a large category inside one prompt', () => {
  // Harborline's Product category held hundreds of insights with zero themes: whatever ran when
  // someone opened that tab did not finish. Chunk, then merge.
  assert.ok(CLUSTER_CHUNK >= 50 && CLUSTER_CHUNK <= 200);
  const chunks = Math.ceil(500 / CLUSTER_CHUNK);
  assert.ok(chunks <= 12, 'a real category must not explode into dozens of model calls');
});

test('the merge prompt folds duplicate candidates and keeps every one accounted for', () => {
  const p = buildThemeMergePrompt(['Same thing, words A', 'Same thing, words B'], 9);
  assert.match(p, /AT MOST 9 final themes/);
  assert.match(p, /exactly one final theme/i);
});

// ── The parser is tolerant, and never invents ────────────────────────────────

test('parseThemeJson reads an array wrapped in prose or fences', () => {
  assert.deepEqual(parseThemeJson('here you go:\n```json\n[{"i":0,"t":1}]\n```'), [{ i: 0, t: 1 }]);
  assert.deepEqual(parseThemeJson('[{"i":2,"t":-1}]'), [{ i: 2, t: -1 }]);
});

test('parseThemeJson returns empty for unusable text rather than throwing', () => {
  // An empty result and an unreadable answer are different facts to the caller; the door
  // records the failure, and these insights must stay pooled rather than vanish.
  assert.deepEqual(parseThemeJson('I could not do that'), []);
  assert.deepEqual(parseThemeJson('[{"i":0,'), []);
  assert.deepEqual(parseThemeJson(''), []);
  assert.deepEqual(parseThemeJson(null), []);
});

test('parseThemeJson rejects a JSON object that is not an array', () => {
  assert.deepEqual(parseThemeJson('{"i":0,"t":1}'), []);
});
