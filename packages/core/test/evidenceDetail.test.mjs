// The middle rung of a citation — the excerpt that proves a quote wasn't cherry-picked.
//
// Same asymmetry as the deep link, one level worse: showing the WRONG passage under a quote
// is showing the reader a conversation that does not contain what we attributed. They will
// conclude we invented it, and they will be reasoning correctly. So the tests are about
// refusing.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/evidenceDetail.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excerptAround, meetingIdFromRef, meetingRefFrom } from '../dist/evidenceDetail.js';

const TRANSCRIPT = [
  'Theo: Thanks for making the time today.',
  'Sarah Chen: Of course. We had a look at the proposal over the weekend.',
  'Theo: And how did the team feel about it?',
  'Sarah Chen: I think procurement is going to be the thing that slows us down.',
  'Theo: What does that process usually look like for you?',
  'Sarah Chen: Legal reviews anything over fifty, so realistically October.',
  'Theo: That still works if we start the pilot now.',
].join('\n');

test('the quote comes back with the conversation around it, and is marked', () => {
  const ex = excerptAround(TRANSCRIPT, 'I think procurement is going to be the thing that slows us down');
  assert.ok(ex);
  const quoted = ex.filter(l => l.isQuote);
  assert.equal(quoted.length, 1, 'exactly one line is the citation');
  assert.match(quoted[0].text, /procurement is going to be the thing/);
  assert.equal(quoted[0].who, 'Sarah Chen');
  // The lines either side are the point: they are what show the quote was not lifted out of
  // a passage that said the opposite.
  assert.ok(ex.length > 1, 'context, not just the quote');
  assert.ok(ex.some(l => /how did the team feel/.test(l.text)), 'what prompted it');
  assert.ok(ex.some(l => /Legal reviews anything over fifty/.test(l.text)), 'where it led');
});

test('speaker labels are parsed off, not left in the text', () => {
  const ex = excerptAround(TRANSCRIPT, 'Legal reviews anything over fifty, so realistically October');
  const quoted = ex.find(l => l.isQuote);
  assert.equal(quoted.who, 'Sarah Chen');
  assert.equal(quoted.text.startsWith('Sarah Chen:'), false);
});

test('punctuation and casing do not stop a match', () => {
  assert.ok(excerptAround(TRANSCRIPT, '"I THINK PROCUREMENT is going to be the thing that slows us down!"'));
});

test('a quote that is not in this transcript returns NOTHING, never the opening lines', () => {
  // The failure that matters. Falling back to the top of the call would put a passage under
  // the citation that does not contain the quote — the reader concludes we made it up.
  assert.equal(excerptAround(TRANSCRIPT, 'the pricing is completely out of our range'), null);
});

test('a quote too short to be distinctive is refused', () => {
  assert.equal(excerptAround(TRANSCRIPT, 'October'), null);
  assert.equal(excerptAround(TRANSCRIPT, 'of course'), null);
});

test('no quote and no transcript both return nothing', () => {
  assert.equal(excerptAround(TRANSCRIPT, null), null);
  assert.equal(excerptAround('', 'I think procurement is going to be the thing'), null);
});

test('every citation from one call normalizes to the SAME canonical ref', () => {
  // The join key. Three note-takers each wrote a different id onto the document they saved
  // (meeting_id, note_id, and in Fathom's case nothing at all), so there was no single thing
  // to join a citation to — which is how long Fathom transcripts
  // ended up in the database completely unreachable.
  const a = meetingRefFrom('source://fireflies/action_item_fireflies_01HX4TQ9ZK7M2P8R5V3W6YB1CD_0');
  const b = meetingRefFrom('source://fireflies/action_item_fireflies_01HX4TQ9ZK7M2P8R5V3W6YB1CD_7');
  const c = meetingRefFrom('source://fireflies/01HX4TQ9ZK7M2P8R5V3W6YB1CD');
  assert.equal(a, 'source://fireflies/01HX4TQ9ZK7M2P8R5V3W6YB1CD');
  assert.equal(a, b, 'two action items from one call must land on one ref');
  assert.equal(a, c, 'an action item and the meeting itself must land on one ref');
});

test('fathom and granola refs normalize too, including ids with - and _', () => {
  // Fathom recording ids carry underscores and hyphens; a character class that only allowed
  // alphanumerics would silently truncate them and join to nothing.
  assert.equal(
    meetingRefFrom('source://fathom/_bQx7TmLp2Vn9RcWk3Yh5Zs8Ju1DfGaE'),
    'source://fathom/_bQx7TmLp2Vn9RcWk3Yh5Zs8Ju1DfGaE',
  );
  assert.equal(meetingRefFrom('source://granola/3c9e1a7d-5b2f-4e8a-9c41'), 'source://granola/3c9e1a7d-5b2f-4e8a-9c41');
  assert.equal(meetingRefFrom('source://fellow/kT7mWq2Rz9Lp4XcN'), 'source://fellow/kT7mWq2Rz9Lp4XcN');
  assert.equal(meetingRefFrom('fellow_kT7mWq2Rz9Lp4XcN_3c9e1a7d-5b2f-4e8a-9c41-123456789abc'), 'source://fellow/kT7mWq2Rz9Lp4XcN');
  // ⭐ Fathom keys an observation `fathom_<recordingId>_<contactId>` — ONE PER ATTENDEE — so
  // a five-person call arrives under five different refs. Without stripping the trailing
  // uuid, every Fathom call in production resolved to nothing.
  const a = meetingRefFrom('source://fathom/fathom_100000001_a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
  const b = meetingRefFrom('source://fathom/fathom_100000001_f6e5d4c3-b2a1-4f0e-9d8c-7b6a5f4e3d2c');
  assert.equal(a, 'source://fathom/100000001');
  assert.equal(a, b, 'two attendees on one call must land on one ref');
  // The ref an insight carries is the BARE recording id, nine digits. It must resolve to the
  // same call as the per-attendee observations above, or the insight cites a call nobody can open.
  assert.equal(meetingRefFrom('source://fathom/100000001'), a, 'a bare Fathom recording id is that call');
  assert.equal(meetingRefFrom('source://fathom/12345'), null, 'too short to be an id');
  assert.equal(meetingRefFrom('source://gmail/18f2a'), null, 'not a meeting');
  assert.equal(meetingRefFrom(null), null);
});

test('the meeting id is read from INSIDE the ref segment, not by splitting on slash', () => {
  // This is why the transcripts looked unreachable: an action item appends its own prefix and
  // index, so the last path segment is not the meeting id. Verified against production — every
  // sampled citation reaches its transcript once parsed this way, none did before.
  assert.equal(
    meetingIdFromRef('source://fireflies/action_item_fireflies_01HX4TQ9ZK7M2P8R5V3W6YB1CD_0'),
    '01HX4TQ9ZK7M2P8R5V3W6YB1CD',
  );
  assert.equal(meetingIdFromRef('source://fireflies/01HX4TQ9ZK7M2P8R5V3W6YB1CD'), '01HX4TQ9ZK7M2P8R5V3W6YB1CD');
  assert.equal(meetingIdFromRef('source://gmail/18f2a'), null);
  assert.equal(meetingIdFromRef(null), null);
});

test('the ff_ prefix does not split one call into two sources', () => {
  // Fireflies writes both shapes for the same meeting. Across the workspace that turned
  // one real call into two stored refs — two panel rows and two tokens for one conversation.
  const a = meetingRefFrom('source://fireflies/ff_01HX5AB7CD3EF9GH2JK4MN6PTS');
  const b = meetingRefFrom('source://fireflies/01HX5AB7CD3EF9GH2JK4MN6PTS');
  assert.equal(a, 'source://fireflies/01HX5AB7CD3EF9GH2JK4MN6PTS');
  assert.equal(a, b, 'both shapes must be one call');
});

test('a git pointer from the plugin plan resolves to the same call', () => {
  // The plugin plan keeps raw in the operator's own repo. Same meeting, different home.
  assert.equal(
    meetingRefFrom('git://nous-raw/raw/fernpoint-ai/2026-04-02-fireflies-01HX6RS8TV2WX4YZ6AB8CD0EFG.md'),
    'source://fireflies/01HX6RS8TV2WX4YZ6AB8CD0EFG',
  );
});

test('stripping is order-dependent and must not eat a real id', () => {
  // `ff_` comes off LAST, after the suffixes, so an id that genuinely starts with other
  // letters is untouched and a per-attendee uuid is still removed first.
  assert.equal(
    meetingRefFrom('source://fathom/fathom_ffa1b2c3d4e5_a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'),
    'source://fathom/ffa1b2c3d4e5',
  );
});

test('a line of only dots is never the match, and a trimmed quote is found by its longest part', () => {
  const transcript = [
    'Wendell: So...',
    'Wendell: ...',
    'Imara: We tried a contractor last spring.',
    'Imara: They promised a long list of the reports they would build for us, but none of it ever actually shipped.',
    'Wendell: What happened?',
  ].join('\n');
  const ex = excerptAround(transcript, 'they promised a long list of the reports... but none of it ever actually shipped', 1);
  assert.ok(ex, 'the quote is in this transcript');
  const hit = ex.find(l => l.isQuote);
  assert.equal(hit.who, 'Imara');
  assert.match(hit.text, /ever actually shipped/);
  assert.equal(ex[0].text, 'We tried a contractor last spring.', 'the line before is the context');
});

test('inside a monologue the excerpt reaches back to the question it answers', () => {
  const transcript = [
    'Saoirse: Why not hand it to a contractor?',
    'Wendell: I think the other side of it is this.',
    'Wendell: I would be handing off how we run the whole rollout.',
    'Wendell: That is a lot for me to let go of.',
    "Wendell: I'm giving up the wheel a little bit.",
    'Wendell: They will never know our stores as well as we do.',
    'Saoirse: That makes sense.',
  ].join('\n');
  const ex = excerptAround(transcript, "I'm giving up the wheel a little bit", 2);
  assert.ok(ex);
  assert.equal(ex[0].who, 'Saoirse', 'the question is included');
  assert.equal(ex[ex.length - 1].who, 'Saoirse', 'and the reply');
  assert.match(ex.find(l => l.isQuote).text, /giving up the wheel/);
});
