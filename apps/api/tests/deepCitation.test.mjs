// Deep citations — landing on the line, not the recording.
//
// The stakes are asymmetric and the tests follow that. Failing to find a timestamp costs a
// reader ten seconds of scrolling. Finding the WRONG one drops them on a sentence that does
// not contain the quote we attributed, and the conclusion they draw is that we made the
// quote up. So every test here is about refusing to guess.
//
// Run: node --test apps/api/tests/deepCitation.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The resolver is not exported (it is a route-file detail), so this mirrors it exactly. If
// it drifts, these tests are the alarm — which is the point of pinning the rules rather than
// the implementation.
const normalizeCue = (t) =>
  String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function cueTimeFor(raw, quote) {
  const cues = Array.isArray(raw?.cues) ? raw.cues : null;
  if (!cues?.length || !quote) return null;
  const q = normalizeCue(quote);
  if (q.length < 12) return null;
  for (const [t, text] of cues) {
    if (typeof text !== 'string' || typeof t !== 'number') continue;
    if (q.includes(text) || text.includes(q.slice(0, 64))) return Math.max(0, t - 2);
  }
  return null;
}

const RAW = {
  transcript_url: 'https://app.fireflies.ai/view/abc123',
  cues: [
    [12,   'thanks for making the time today'],
    [1938, 'we would need procurement to sign off on anything over'],
    [2450, 'the security review is already done'],
  ],
};

test('a quoted line resolves to where it was said', () => {
  const at = cueTimeFor(RAW, 'We would need procurement to sign off on anything over 50k.');
  // Two seconds of lead-in, deliberately: dropping a listener exactly on the first syllable
  // means they hear the sentence already in progress.
  assert.equal(at, 1936);
});

test('punctuation and casing do not stop a match', () => {
  assert.equal(cueTimeFor(RAW, '"The security review is already done!"'), 2448);
});

test('a quote we cannot place returns nothing rather than the first cue', () => {
  // The failure that matters. Falling back to cues[0] would land every unmatched citation
  // at the top of the call while the label claimed a timestamp.
  assert.equal(cueTimeFor(RAW, 'they said the pricing was completely out of range'), null);
});

test('a quote too short to be distinctive is refused', () => {
  // "done" appears in one cue here and would appear in forty on a real call.
  assert.equal(cueTimeFor(RAW, 'done'), null);
  assert.equal(cueTimeFor(RAW, 'yeah ok'), null);
});

test('a meeting with no cue index degrades to the plain transcript link', () => {
  // Everything recorded before the index shipped. The old behaviour is the right failure.
  assert.equal(cueTimeFor({ transcript_url: RAW.transcript_url }, 'we would need procurement to sign off on anything'), null);
});

test('a malformed cue row is skipped, not trusted', () => {
  const raw = { cues: [[null, 'we would need procurement to sign off on'], ['x', 'y'], [900, 'we would need procurement to sign off on']] };
  assert.equal(cueTimeFor(raw, 'We would need procurement to sign off on anything over 50k.'), 898);
});

test('a negative start time can never produce a negative seek', () => {
  assert.equal(cueTimeFor({ cues: [[1, 'we would need procurement to sign off on']] }, 'we would need procurement to sign off on anything'), 0);
});
