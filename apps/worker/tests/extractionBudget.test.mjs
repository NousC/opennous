// Long calls must not lose parts (measured on the extraction test set, 2026-10-08): a 24,000-
// character part came back empty from the primary model AND its fallback (finish: length), was
// halved, retried and timed out — 5 of 12 calls, with the longer prompt the claim fixes brought.
// Smaller parts and more room to answer.
//
// Run: node --test apps/worker/tests/extractionBudget.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PART_CHARS, splitForExtraction } from '../src/signals/extractionText.mjs';
import { buildActivitySignalsPrompt } from '../src/signals/index.mjs';

test('a part is at most 14,000 characters', () => {
  assert.ok(PART_CHARS <= 14_000);
  const { parts } = splitForExtraction('Dana: something said on the call.\n'.repeat(3000));
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => p.length <= 14_000));
});

test('the output budget leaves room to think and answer', () => {
  const meeting = buildActivitySignalsPrompt({ contactName: 'Dana Reyes', type: 'meeting_held', summary: 't' });
  assert.ok(meeting.maxTokens >= 1500, `meeting budget ${meeting.maxTokens}`);
  const message = buildActivitySignalsPrompt({ contactName: 'Dana Reyes', type: 'email_received', summary: 't' });
  assert.ok(message.maxTokens >= 1500, `message budget ${message.maxTokens}`);
  const deep = buildActivitySignalsPrompt({ contactName: 'Dana Reyes', type: 'meeting_held', summary: 't', maxFactsOverride: 40 });
  assert.ok(deep.maxTokens <= 4000);
});
