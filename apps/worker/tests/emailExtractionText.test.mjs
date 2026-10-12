// An email is extracted from what was written, not from its 300-character preview (GET-256).
// The Gmail handler stored summary = the preview and the full body as body_text; activityText
// reads raw.text, which nothing set — so reply labels, action items and facts all saw two sentences.
//
// Run: node --test apps/worker/tests/emailExtractionText.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityText } from '../src/signals/extractionText.mjs';
import { messageBodyText } from '@nous/core';

const long = 'Thanks for the call. ' + 'We run HubSpot for sales and the CS team lives in spreadsheets. '.repeat(12)
  + 'Budget is approved for Q4 and the CRO signs off.';

test('extraction reads the whole written message when the source keeps it', () => {
  const preview = long.slice(0, 300);
  const text = activityText({ summary: preview, description: preview, raw: { text: long, body_text: long } });
  assert.equal(text, long);
  assert.match(text, /Budget is approved for Q4/);
});

test('without raw.text it still falls back to the preview', () => {
  assert.equal(activityText({ summary: 'short preview', raw: { body_text: long } }), 'short preview');
});

test('the written text drops the quoted thread, so an old "unsubscribe" footer never reaches the classifier', () => {
  const reply = '<div>Yes, Tuesday works.</div><div class="gmail_quote">On Mon, Sep 14 Theo wrote:<blockquote>Click to unsubscribe</blockquote></div>';
  const written = messageBodyText(reply, { preview: true });
  assert.equal(written, 'Yes, Tuesday works.');
});
