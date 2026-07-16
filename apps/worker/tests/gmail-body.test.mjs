/**
 * Gmail body extraction tests — pure, no Gmail API needed.
 * Covers MIME tree walking, base64url decoding, multipart structures, and size capping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBody, capBody, MAX_BODY_BYTES } from '../src/pollers/gmail.mjs';

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');

// ── extractBody — leaf and multipart shapes ───────────────────────────────────

test('extractBody pulls plaintext from a single text/plain part', () => {
  const payload = {
    mimeType: 'text/plain',
    body: { data: b64url('Hello, this is the body.') },
  };
  const { text, html } = extractBody(payload);
  assert.equal(text, 'Hello, this is the body.');
  assert.equal(html, null);
});

test('extractBody walks multipart/alternative and returns both text and html', () => {
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', body: { data: b64url('Plain version') } },
      { mimeType: 'text/html',  body: { data: b64url('<p>HTML version</p>') } },
    ],
  };
  const { text, html } = extractBody(payload);
  assert.equal(text, 'Plain version');
  assert.equal(html, '<p>HTML version</p>');
});

test('extractBody recursively walks nested multipart trees (multipart/mixed → multipart/alternative)', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('Deep plaintext') } },
          { mimeType: 'text/html',  body: { data: b64url('<b>Deep html</b>') } },
        ],
      },
      // Simulated attachment part — should be skipped (no text/* mimeType)
      { mimeType: 'application/pdf', body: { attachmentId: 'att-1' } },
    ],
  };
  const { text, html } = extractBody(payload);
  assert.equal(text, 'Deep plaintext');
  assert.equal(html, '<b>Deep html</b>');
});

test('extractBody returns nulls when payload is empty or has no decodable parts', () => {
  assert.deepEqual(extractBody(null), { text: null, html: null });
  assert.deepEqual(extractBody({}), { text: null, html: null });
  assert.deepEqual(
    extractBody({ mimeType: 'application/octet-stream', body: { size: 100 } }),
    { text: null, html: null },
  );
});

test('extractBody handles malformed base64 gracefully (does not throw)', () => {
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      // Valid plaintext
      { mimeType: 'text/plain', body: { data: b64url('Good text') } },
      // Junk html — Buffer.from(..., 'base64url') is permissive so this still "decodes",
      // but the function must never throw on any part.
      { mimeType: 'text/html',  body: { data: '!!!not-valid!!!' } },
    ],
  };
  assert.doesNotThrow(() => extractBody(payload));
  const { text } = extractBody(payload);
  assert.equal(text, 'Good text');
});

// ── capBody ────────────────────────────────────────────────────────────────────

test('capBody returns null for falsy input', () => {
  assert.equal(capBody(null), null);
  assert.equal(capBody(undefined), null);
  assert.equal(capBody(''), null);
});

test('capBody returns the string unchanged when under the cap', () => {
  const s = 'short body content';
  assert.equal(capBody(s), s);
});

test('capBody truncates strings larger than MAX_BODY_BYTES', () => {
  const oversized = 'a'.repeat(MAX_BODY_BYTES + 5000);
  const capped = capBody(oversized);
  assert.equal(capped.length, MAX_BODY_BYTES);
  assert.ok(Buffer.byteLength(capped, 'utf8') <= MAX_BODY_BYTES);
});
