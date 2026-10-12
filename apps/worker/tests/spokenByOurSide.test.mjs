// Our words are not their facts (GET-417): a quote's speaker, read off the transcript labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speakerOfQuote, spokenByOurSide } from '../src/noema/grounding.mjs';

const transcript = `Sorrel Penhallow: My guess is the setup time is what worries your team most.
Augustin Pell: Yeah, setup has dragged on a bit for us this quarter.
Sorrel Penhallow: Orders look steady, so the checkout side is working.
Cassius Rendle: Honestly we only ever used
half of the reports you built for us.`;

test('the speaker is the label on the quote\'s turn', () => {
  assert.equal(speakerOfQuote("setup time is what worries your team most", transcript), 'Sorrel Penhallow');
  assert.equal(speakerOfQuote("setup has dragged on a bit", transcript), 'Augustin Pell');
  assert.equal(speakerOfQuote("we only ever used half of the reports you built", transcript), 'Cassius Rendle', 'a quote across a line break');
  assert.equal(speakerOfQuote('nothing like this was said', transcript), null);
});

test('our side is matched by full name or first name; the customer is not', () => {
  assert.equal(spokenByOurSide("setup time is what worries your team most", transcript, ['Sorrel Penhallow']), true);
  assert.equal(spokenByOurSide("orders look steady", transcript, ['Sorrel']), true, 'transcripts say "Sorrel:" as often as "Sorrel Penhallow:"');
  assert.equal(spokenByOurSide("setup has dragged on a bit", transcript, ['Sorrel Penhallow']), false);
  assert.equal(spokenByOurSide("setup has dragged on a bit", transcript, []), false);
  assert.equal(spokenByOurSide('nothing like this was said', transcript, ['Sorrel Penhallow']), false, 'unknown speaker is not evidence');
});
