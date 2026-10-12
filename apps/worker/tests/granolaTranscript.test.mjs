// Granola transcripts (GET-236): Granola marks each line as the recorder's microphone ("me") or
// everyone else ("them"). Those lines used to come out unlabelled, so the call review could not
// tell the rep from the buyer and guessed names. Now "me" is the owner by name, "them" is "Them",
// and the timings give the rep's measured share of the talking.
//
// Run: node --test apps/worker/tests/granolaTranscript.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGranolaTranscript } from '../src/webhooks/handlers/granola.mjs';

const at = (s) => new Date(Date.UTC(2026, 8, 14, 16, 0, s)).toISOString();
const line = (text, from, to, attribution) => ({
  text, start_time: at(from), end_time: at(to),
  speaker: { source: attribution === 'me' ? 'microphone' : 'speaker', attribution },
});

test('me / them lines are labelled with the owner and "Them", and talk share is measured', () => {
  const out = buildGranolaTranscript([
    line('So this call is with the team.', 0, 30, 'them'),
    line('Great, let me walk you through it.', 30, 40, 'me'),
    line('What does the backfill cover?', 40, 50, 'them'),
  ], 'Theo Bramwell');
  assert.equal(out.text, 'Them: So this call is with the team.\nTheo Bramwell: Great, let me walk you through it.\nThem: What does the backfill cover?');
  assert.equal(out.repTalkShare, 10 / 50);
  assert.deepEqual(out.speakerNames, [], '"Them" is not a person to resolve');
});

test('named speakers still come through as names', () => {
  const out = buildGranolaTranscript([{ text: 'Hello', speaker: { name: 'Rowan Achterberg' } }], 'Theo');
  assert.equal(out.text, 'Rowan Achterberg: Hello');
  assert.deepEqual(out.speakerNames, ['Rowan Achterberg']);
  assert.equal(out.repTalkShare, null);
});

test('with no owner name the recorder reads as "Me"', () => {
  const out = buildGranolaTranscript([line('Hi', 0, 1, 'me')]);
  assert.equal(out.text, 'Me: Hi');
});
