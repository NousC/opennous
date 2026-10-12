// Which sources the backlog backfill picks (backfillExtraction.mjs). Pure selection, no
// database, no model.
//
// Run: node --test apps/worker/tests/backfillExtraction.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectBackfillUnits, isTeammateName, isSeedRecord, unitId } from '../src/backfillExtraction.mjs';
import { extractionSkipReason } from '../src/signals/index.mjs';

const pitch = 'Hi Theo - I\'m Emrys, I look after partnerships at Quillmere. We are opening a second office this spring.';
const obs = (id, over = {}) => ({
  id, entity_id: 'p1', property: 'interaction.linkedin_message', source: 'linkedin', raw: {}, value: { summary: pitch }, ...over,
});
const select = (observations, { extracted = [], external = ['p1', 'p2', 'p3'] } = {}) =>
  selectBackfillUnits({ observations, extractedIds: new Set(extracted), externalIds: new Set(external) });

test('an inbound message from an external person with no claims is picked', () => {
  const { units } = select([obs('a')]);
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, 'message');
});

test('what live ingest would not extract is not picked either', () => {
  const { units, skipped } = select([
    obs('sent', { raw: { is_outbound: true } }),
    obs('you', { value: { summary: 'You: happy to share the deck with you' } }),
    obs('done'),
    obs('internal', { entity_id: 'teammate' }),
    obs('short', { value: { summary: 'Thanks!' } }),
    obs('notice', { value: { summary: 'Rowan has joined the channel #founders today' } }),
    obs('booking', { property: 'interaction.meeting_booked' }),
  ], { extracted: ['done'] });
  assert.equal(units.length, 0);
  assert.deepEqual(skipped, {
    'sent by us': 2, 'already has claims': 1, 'not an active external person': 1,
    'under 20 characters': 1, 'system notice': 1, 'not an extracted type': 1,
  });
});

test('a call is one unit covering every external attendee who lacks claims — never one pass per attendee', () => {
  const meeting = (id, entity) => obs(id, { entity_id: entity, property: 'interaction.meeting_held', source: 'fireflies', raw: { meeting_id: 'M1' }, value: { summary: 'x' } });
  const { units } = select([meeting('m-a', 'p1'), meeting('m-b', 'p2'), meeting('m-c', 'p3')], { extracted: ['m-c'] });
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, 'meeting');
  assert.deepEqual(units[0].observations.map(o => o.entity_id), ['p1', 'p2']);
  assert.equal(unitId(units[0]), 'm-a');
});

test('a meeting is not judged on its short summary — the full transcript is loaded later', () => {
  const { units } = select([obs('m', { property: 'interaction.meeting_held', source: 'fireflies', raw: { meeting_id: 'M2' }, value: { summary: 'Call' } })]);
  assert.equal(units.length, 1);
});

test('a message is judged on its fullest text, not the 200-character summary', () => {
  const long = 'x'.repeat(30);
  const { units } = select([obs('a', { value: { summary: 'Hi', description: 'Hi' }, raw: { text: long } })]);
  assert.equal(units.length, 1);
});

test('units are ordered by id, so --after continues a batch exactly', () => {
  const { units } = select([obs('c'), obs('a'), obs('b')]);
  assert.deepEqual(units.map(unitId), ['a', 'b', 'c']);
});

test("a teammate's second, unflagged record is recognised by name", () => {
  const team = ['Theo', 'Avery Castellan'];
  assert.equal(isTeammateName('Theo Bramwell', team), true, 'the account holds only a first name');
  assert.equal(isTeammateName('Avery Castellan', team), true);
  assert.equal(isTeammateName('Avery Patel', team), false, 'a full-name member matches only the full name');
  assert.equal(isTeammateName('Ignatius Fernsby', team), false);
});

test('extractionSkipReason is the live gate', () => {
  assert.equal(extractionSkipReason({ type: 'linkedin_message', text: pitch }), null);
  assert.match(extractionSkipReason({ type: 'linkedin_message', text: 'ok' }), /under 20/);
  assert.match(extractionSkipReason({ type: 'meeting_booked', text: pitch }), /not extracted/);
});

test('demo seed records are never backfilled', () => {
  assert.equal(isSeedRecord('[nous-seed] Tomas Seed4'), true);
  assert.equal(isSeedRecord('Tomas Nousseed'), false);
});
