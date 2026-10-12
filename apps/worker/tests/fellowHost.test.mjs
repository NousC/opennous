// Who ran a Fellow call (GET-229). Fellow's webhook names the calendar organizer; its REST
// list does not, so a polled call has one signal only: the attendee on our own email domain.
//
// This is the shape of the case that produced the bug worth writing down. Sorrel hosted "Pellham
// Ford/Lincoln x Harborline.example" on sorrel@harborline.example and has no Nous seat, so the call landed with no owner and
// she was read as a buyer-side attendee — no evidence file, no relationship, nothing for
// coaching to attribute. Picking the host by our own domain fixes the side; storing the host
// EMAIL (whether or not it maps to a seat) is what lets it attach the day she gets one.
//
// Run: node --test apps/worker/tests/fellowHost.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickHostEmail, domainOf } from '../src/webhooks/handlers/fellow.mjs';

const PELLHAM = [
  { email: 'sorrel@harborline.example' },
  { email: 'raldous@pellhamford.example' },
  { email: 'mquill@pellhamford.example' },
];

test('a polled call takes the host from our own email domain', () => {
  assert.equal(pickHostEmail(PELLHAM, null, 'nous@harborline.example'), 'sorrel@harborline.example');
});

test('the calendar organizer wins whenever Fellow names one', () => {
  assert.equal(pickHostEmail(PELLHAM, 'perrin@harborline.example', 'nous@harborline.example'), 'perrin@harborline.example');
});

test('no host at all, rather than one from the buyer side', () => {
  // An internal-only recording of a customer call, and a workspace whose Fellow account we
  // could not read: both must leave the call unowned instead of crowning an attendee.
  assert.equal(pickHostEmail([{ email: 'raldous@pellhamford.example' }], null, 'nous@harborline.example'), null);
  assert.equal(pickHostEmail(PELLHAM, null, null), null);
  assert.equal(pickHostEmail([], null, 'nous@harborline.example'), null);
});

test('domains compare case-insensitively, and a subdomain is a different company', () => {
  assert.equal(pickHostEmail([{ email: 'Sorrel@Harborline.example' }], null, 'nous@harborline.example'), 'Sorrel@Harborline.example');
  assert.equal(pickHostEmail([{ email: 'x@mail.harborline.example' }], null, 'nous@harborline.example'), null);
  assert.equal(domainOf('a@b.example'), 'b.example');
  assert.equal(domainOf('no-at-sign'), null);
  assert.equal(domainOf(null), null);
});

// One builder for a call fetched from Fellow's REST API — the poller and the agent-driven
// resolve both go through it, so a call resolved by id is identical to a polled one.
test('a recording + its note become the call the pipeline reads', async () => {
  const { callFromRecording } = await import('../src/webhooks/handlers/fellow.mjs');
  const call = callFromRecording({
    id: 'rec_TEST0001', note_id: 'note_TEST0001', title: 'Pellham Ford/Lincoln x Harborline.example',
    started_at: '2026-09-10T15:58:30.000Z',
    transcript: { speech_segments: [
      { start: 0, end: 1, speaker: 'Sorrel Penhallow', text: 'Thanks for making time.' },
      { start: 1, end: 2, speaker: 'Speaker 2', text: 'No problem.' },
    ] },
    ai_notes: [{ sections: [{ title: 'Summary', type: 'text', content: 'Walked through the reporting setup.' }] }],
  }, {
    id: 'note_TEST0001', title: 'Pellham Ford/Lincoln x Harborline.example', event_start: '2026-09-10T16:00:00Z',
    event_attendees: [{ email: 'sorrel@harborline.example' }, { email: 'raldous@pellhamford.example' }],
  });
  // The NOTE id is the join key: a call polled today and re-delivered by a webhook tomorrow
  // must dedup on the same external id.
  assert.equal(call.noteId, 'note_TEST0001');
  assert.equal(call.occurredAt, '2026-09-10T16:00:00Z');   // the invite time beats the recorder's clock
  assert.deepEqual(call.attendees.map(a => a.email), ['sorrel@harborline.example', 'raldous@pellhamford.example']);
  assert.deepEqual(call.speakerNames, ['Sorrel Penhallow']);     // "Speaker 2" names nobody
  assert.match(call.transcriptText, /^Sorrel Penhallow: Thanks for making time\./);
  assert.match(call.aiNotes, /Walked through the reporting setup/);
  assert.equal(call.connectedUserRecorded, false);          // a polled call was not recorded by us
});

test('a recording with no note still lands, keyed on the recording', async () => {
  const { callFromRecording } = await import('../src/webhooks/handlers/fellow.mjs');
  const call = callFromRecording({ id: 'abc123', started_at: '2026-09-16T10:00:00Z' }, null);
  assert.equal(call.noteId, 'rec_abc123');
  assert.equal(call.title, 'Untitled Meeting');
  assert.deepEqual(call.attendees, []);
});

// Our own people are not the customer (GET-288). `isEntityInternal` reads a claim asserted from
// workspace MEMBERS, and a client whose reps have no seats has none — so Harborline's own CS manager
// read as a buyer, and the call page filed itself on Harborline instead of the dealership.
test('the account a call belongs to is the CUSTOMER, not us', async () => {
  const { domainOf } = await import('../src/webhooks/handlers/fellow.mjs');
  const ours = domainOf('nous@harborline.example');
  const onTheCall = [
    { email: 'perrin@harborline.example',        company: 'Harborline.example',      company_id: 'co-harborline' },
    { email: 'test.dealer.0003@gmail.com', company: 'Quillmoor RV', company_id: 'co-quillmoor' },   // fake local part on free mail,
  ];
  const buyers = onTheCall.filter(c => domainOf(c.email) !== ours);
  assert.deepEqual(buyers.map(b => b.company_id), ['co-quillmoor']);
  // The page's account is the first buyer — the dealership, never the seller.
  assert.equal(buyers[0].company_id, 'co-quillmoor');
});

test('without a known domain nothing changes — the seat check still decides', async () => {
  const { domainOf } = await import('../src/webhooks/handlers/fellow.mjs');
  assert.equal(domainOf(null), null);
  assert.equal(domainOf('nous@harborline.example'), 'harborline.example');
});

// A call page belongs to the ACCOUNT (GET-288). Filed on a person, the Accounts list reads as a
// list of people — "Lena Quist" where "Larkfield Toyota" belongs.
test('the page is filed on the company, not whoever spoke first', async () => {
  const { pickAccountEntityId } = await import('../src/webhooks/handlers/fellow.mjs');
  const lena = { contactId: 'p-lena', companyId: null };
  const dealerContact = { contactId: 'p-raldous', companyId: 'co-larkfield' };
  assert.equal(pickAccountEntityId([lena, dealerContact]), 'co-larkfield');
  // Only when nobody's company is known does the person stand in for the account.
  assert.equal(pickAccountEntityId([lena]), 'p-lena');
  assert.equal(pickAccountEntityId([]), null);
  assert.equal(pickAccountEntityId(null), null);
});
