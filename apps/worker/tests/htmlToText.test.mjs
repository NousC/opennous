// Message bodies as text (GET-249). Fixtures are the shapes that showed up on a contact's timeline (names invented).
//
// Run: node --test apps/worker/tests/htmlToText.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, messageBodyText, decodeEntities, looksLikeHtml, dropQuotedText, splitMessage } from '@nous/core';

test('a Gmail reply becomes the words that were written, without the quoted thread', () => {
  const html = '<div dir="ltr">Thank you, we will send you an NDA to sign before.</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Sep 14, 2026 at 1:41 PM Avery Castellan wrote:<br></div><blockquote class="gmail_quote">Rowan, here is the DPA.</blockquote></div>';
  assert.equal(messageBodyText(html, { preview: true }), 'Thank you, we will send you an NDA to sign before.');
  assert.match(messageBodyText(html), /Rowan, here is the DPA\./, 'the full body keeps the quote');
});

test('entities decode — named, decimal and hex', () => {
  assert.equal(decodeEntities('Here&#39;s the plan &amp; the &quot;DPA&quot; &#x2014; ok'), 'Here\'s the plan & the "DPA" — ok');
  assert.equal(htmlToText('<p>Hi&nbsp;Rowan,</p><p>Let’s get started</p>'), 'Hi Rowan,\nLet’s get started');
});

test('styles, scripts and comments never leak into the text', () => {
  assert.equal(htmlToText('<style>p{font-size:50px}</style><!-- x --><p style="font-size:50px">🎉 Avery reacted</p><script>alert(1)</script>'), '🎉 Avery reacted');
});

test('plain text passes through; a < in prose is not HTML', () => {
  assert.equal(looksLikeHtml('we need budget < 10k'), false);
  assert.equal(messageBodyText('Budget is < 10k & timing is Q4'), 'Budget is < 10k & timing is Q4');
});

test('plain-text quoted history is dropped from a preview', () => {
  assert.equal(dropQuotedText('Sounds good, Tuesday works.\n\nOn Thu, Sep 10, 2026 at 9:03 AM Avery wrote:\n> Does Monday work?'), 'Sounds good, Tuesday works.');
  assert.equal(dropQuotedText('Yes.\n> old line'), 'Yes.');
});

test('lists keep their items on separate lines', () => {
  assert.equal(htmlToText('Tech Stack:<ul><li>Hubspot</li><li>ZoomInfo</li></ul>'), 'Tech Stack:\n• Hubspot\n• ZoomInfo');
});

// GET-277: a row shows THIS email, never the thread stacked under it.
test('a message that is only quoted history keeps nothing of its own', () => {
  const forward = 'On Tue, Sep 15, 2026 at 10:32 AM Avery Castellan < a@x.example > wrote:\n\nRufus, quick status on the keys.';
  assert.equal(messageBodyText(forward, { preview: true }), '', 'no new text of its own');
  assert.match(messageBodyText(forward), /quick status/, 'the full text is still available');
});

test('splitMessage separates what was written from the thread under it', () => {
  const reply = 'Sounds good, Tuesday works.\n\nOn Thu, Sep 10, 2026 at 9:03 AM Avery wrote:\n> Does Monday work?';
  const { written, quotedChars } = splitMessage(reply);
  assert.equal(written, 'Sounds good, Tuesday works.');
  assert.ok(quotedChars > 30, 'says how much history was dropped');
});
