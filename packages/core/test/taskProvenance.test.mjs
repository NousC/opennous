// Where a task came from and who it is for — the pure halves (GET-400).
//
// Run: node --test packages/core/test/taskProvenance.test.mjs   (after `tsc`)
//
// The rule under test is the same in all three: say what the source said, or say nothing. A "for"
// that guesses between two Jaspers, a deal picked out of two open ones, a description that repeats
// the title — each would put a confident wrong fact on a row a rep acts on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPersonByName, pickOnlyOpenDeal, provenanceFromModel, emptyTaskProvenance } from '../dist/services/taskProvenance.js';
import { parseHealthReadJson } from '../dist/services/accountHealth.js';

const roster = [
  { id: 'e-barnaby', first_name: 'Barnaby', last_name: 'Fenwick', email: 'barnaby@quarrendonnissan.example' },
  { id: 'e-ottoline', first_name: 'Ottoline', last_name: 'Brisk' },
  { id: 'e-jasper-v', first_name: 'Jasper', last_name: 'Vantongeren' },
  { id: 'e-jasper', first_name: 'Jasper', last_name: null },
  { id: 'e-tamsin', name: 'Tamsin Rowe', email: 'tamsin@harborline.example' },
];

test('a first name resolves when exactly one person on the call answers to it', () => {
  assert.equal(matchPersonByName('Barnaby', roster)?.id, 'e-barnaby');
  assert.equal(matchPersonByName('barnaby fenwick', roster)?.id, 'e-barnaby', 'case does not matter');
  assert.equal(matchPersonByName('Tamsin', roster)?.id, 'e-tamsin', 'a `name` field counts the same as first+last');
});

test('two Jaspers resolve to nobody — a wrong "for" is worse than none', () => {
  assert.equal(matchPersonByName('Jasper', roster), null);
  assert.equal(matchPersonByName('Jasper Vantongeren', roster)?.id, 'e-jasper-v', 'the full name still picks one');
});

test('a name nobody on the call has, or no name, resolves to nobody', () => {
  assert.equal(matchPersonByName('Leopold', roster), null);
  assert.equal(matchPersonByName('', roster), null);
  assert.equal(matchPersonByName(null, roster), null);
  assert.equal(matchPersonByName('Barnaby', []), null);
});

test('one open deal is the deal; none or several is no guess', () => {
  assert.deepEqual(pickOnlyOpenDeal([{ id: 'd1', status: 'open' }, { id: 'd0', status: 'won' }]), { deal_id: 'd1', deal_link: 'only_open_deal' });
  assert.deepEqual(pickOnlyOpenDeal([{ id: 'd1', status: 'open' }, { id: 'd2', status: 'open' }]), { deal_id: null, deal_link: null });
  assert.deepEqual(pickOnlyOpenDeal([{ id: 'd0', status: 'lost' }]), { deal_id: null, deal_link: null });
  assert.deepEqual(pickOnlyOpenDeal([]), { deal_id: null, deal_link: null });
  // A deal with no status yet is treated as open — that is what the deal list does too.
  assert.deepEqual(pickOnlyOpenDeal([{ id: 'd1', status: null }]), { deal_id: 'd1', deal_link: 'only_open_deal' });
});

test('the model\'s context, for and asked_by are trimmed; a description that repeats the title is dropped', () => {
  const p = provenanceFromModel(
    { context: '  Barnaby wants the LV signup steps.  ', for: ' Barnaby ', asked_by: 'Barnaby' },
    'Tamsin to send Lumen Verify sign-up information.',
  );
  assert.deepEqual(p, { description: 'Barnaby wants the LV signup steps.', for_name: 'Barnaby', asked_by: 'Barnaby' });
  assert.equal(provenanceFromModel({ context: 'Send the deck' }, 'send the deck').description, null, 'a restated title is not context');
  assert.deepEqual(provenanceFromModel({}, 'x'), { description: null, for_name: null, asked_by: null });
  assert.deepEqual(provenanceFromModel(null, null), { description: null, for_name: null, asked_by: null });
});

test('an empty provenance block names every field, all null, so a writer cannot leave one out', () => {
  const e = emptyTaskProvenance();
  assert.deepEqual(Object.keys(e).sort(), [
    'asked_by', 'deal_id', 'deal_link', 'description', 'for_entity_id', 'for_name', 'occurred_at', 'source_title', 'source_url',
  ]);
  assert.ok(Object.values(e).every(v => v === null));
});

test('the health read carries for, asked_by and context on each commitment, and "" when the model is older', () => {
  const parsed = parseHealthReadJson(JSON.stringify({
    summary: 's', what_changed: 'w', adoption: 'a', standing: 'neutral', risks: [], expansion: [],
    commitments: [
      { text: 'Tamsin to send Lumen Verify sign-up information.', quote: 'So I\'m going to send over that information to you.', owner: 'us', due: '', for: 'Barnaby', asked_by: 'Barnaby', context: 'Barnaby agreed to the Lumen Verify signup and wants the steps.' },
      { text: 'Barnaby to review the emails.', quote: 'Please send those emails and I\'ll get to it when I can.', owner: 'them', due: '' },
    ],
  }));
  assert.ok(parsed, 'a read with commitments parses');
  const [ours, theirs] = parsed.commitments;
  assert.equal(ours.for, 'Barnaby');
  assert.equal(ours.asked_by, 'Barnaby');
  assert.equal(ours.context, 'Barnaby agreed to the Lumen Verify signup and wants the steps.');
  assert.equal(theirs.owner, 'them');
  assert.equal(theirs.for, '');
  assert.equal(theirs.asked_by, '');
  assert.equal(theirs.context, '');
});

// ── commitments on every call (GET-418) ───────────────────────────────────────
import { buildCommitmentsPrompt, parseCommitmentsJson } from '../dist/services/accountHealth.js';

test('the commitments-only read asks the same question as the health read and parses the same shape', () => {
  const prompt = buildCommitmentsPrompt('Tamsin: I will send it Friday.', { title: 'Discovery — Acme', callType: 'discovery', people: [{ name: 'Tamsin', side: 'team' }] });
  assert.match(prompt, /commitments: 0–8 items/);
  assert.match(prompt, /"for","asked_by","context"/);
  assert.match(prompt, /CALL: Discovery — Acme/);
  const parsed = parseCommitmentsJson('{"commitments":[{"text":"Tamsin to send the proposal Friday.","quote":"I will send it Friday.","owner":"us","due":"Friday","for":"Crispin","asked_by":"","context":"Crispin asked for pricing before the board meeting."}]}');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].owner, 'us');
  assert.equal(parsed[0].for, 'Crispin');
  assert.equal(parsed[0].context, 'Crispin asked for pricing before the board meeting.');
  assert.deepEqual(parseCommitmentsJson('no json here'), []);
  assert.deepEqual(parseCommitmentsJson('{"commitments":[]}'), []);
});
