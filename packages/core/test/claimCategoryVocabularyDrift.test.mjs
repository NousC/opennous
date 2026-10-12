// The taxonomy guards its own consumers.
//
// GET-370: the `record` MCP tool documented 13 of the 17 claim categories. The API
// accepted all 17 and `normalizeClaimCategory` handled them correctly — only the tool's
// own description was short. But that description IS the vocabulary as far as a calling
// agent is concerned, and the four it omitted (adoption, proficiency, seasonality,
// staff_change) accounted for roughly a third of the facts in one backfill.
//
// An agent that trusts the description loses a third of its yield and reports success.
// One did worse — it concluded the missing categories were being "silently rejected"
// and refiled a fact under a different category, creating a duplicate.
//
// apps/mcp is published to npm as @opennous/mcp and deliberately has no @nous/core
// dependency, so the list cannot be generated from CLAIM_CATEGORY_KEYS at runtime. This
// test is the substitute: the second copy may exist, but it may not drift.
//
// Run: node --test packages/core/test/claimCategoryVocabularyDrift.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CLAIM_CATEGORY_KEYS } from '../dist/db/claimCategories.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, '..', '..', '..', 'apps', 'mcp', 'src', 'server.js');

test('the record tool description names every claim category', () => {
  const src = readFileSync(SERVER, 'utf8');
  // The vocabulary is spelled out in the tool description as `a | b | c`. Find the run
  // that starts at status_quo and ends at general, and read the keys out of it.
  const m = src.match(/status_quo \| [^)]*?general/s);
  assert.ok(m, 'could not find the category vocabulary in the record tool description');
  const documented = new Set(
    m[0].split('|').map(s => s.replace(/["+\s]/g, '')).filter(Boolean),
  );

  const missing = CLAIM_CATEGORY_KEYS.filter(k => !documented.has(k));
  assert.deepEqual(missing, [],
    `record's description is missing ${missing.length} categor${missing.length === 1 ? 'y' : 'ies'}: ` +
    `${missing.join(', ')}. An agent can only use what the tool tells it exists.`);
});

test('the description does not invent categories the taxonomy lacks', () => {
  // The other direction: a documented key that normalizeClaimCategory would coerce is
  // just as bad, because the agent's chosen category silently becomes something else.
  const src = readFileSync(SERVER, 'utf8');
  const m = src.match(/status_quo \| [^)]*?general/s);
  const documented = [...new Set(
    m[0].split('|').map(s => s.replace(/["+\s]/g, '')).filter(Boolean),
  )];
  const unknown = documented.filter(k => !CLAIM_CATEGORY_KEYS.includes(k));
  assert.deepEqual(unknown, [], `record documents categories that do not exist: ${unknown.join(', ')}`);
});
