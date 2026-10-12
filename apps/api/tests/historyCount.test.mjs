// Counting history at the source, before the backfill (GET-549).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressQueries, monthlyCredits } from '../src/lib/historyCount.mjs';

test('searches are OR-batched 20 people at a time, deduped and lower-cased', () => {
  const qs = addressQueries(['A@x.com', 'a@x.com', 'b@y.com', 'nope'], 90);
  assert.deepEqual(qs, ['newer_than:90d {from:a@x.com to:a@x.com cc:a@x.com from:b@y.com to:b@y.com cc:b@y.com}']);
  assert.equal(addressQueries(Array.from({ length: 41 }, (_, i) => `p${i}@z.com`), 30).length, 3);
});

test('a month bills 2 credits a thread or call, plus the meetings by length', () => {
  assert.equal(monthlyCredits({ counts: { email_thread: 100, call: 10, meeting: 5 }, meetingCredits: 30 }), 250);
  assert.equal(monthlyCredits({ counts: {}, meetingCredits: 0 }), 0);
});

// ── Who the note-taker's meetings add that the graph does not hold (GET-788) ─────────────────
import { newFromNotetakers } from '../src/lib/historyCount.mjs';

/** A read-only stand-in for the few queries newFromNotetakers makes: select / eq / in, awaited. */
function fakeDb(tables) {
  return {
    from(table) {
      let rows = [...(tables[table] ?? [])];
      const b = {
        select: () => b, eq: () => b, limit: () => b, order: () => b,
        in: (col, vals) => { const set = new Set(vals); rows = rows.filter(r => set.has(r[col])); return b; },
        then: (ok, bad) => Promise.resolve({ data: rows, error: null }).then(ok, bad),
      };
      return b;
    },
  };
}

test('counts the outside people a note-taker will add, and their new companies, leaving out us and who we hold', async () => {
  const db = fakeDb({
    workspace_members: [{ user_id: 'u1', users: { email: 'avery@harborline.example', name: 'Avery' } }],
    workflow_provider_connections: [], workspace_linkedin_connections: [],
    entity_identifiers: [{ value: 'dana.whit@fernpoint.example' }],
    companies: [{ domain: 'fernpoint.example' }],
  });
  const attendees = new Map([
    ['avery@harborline.example', 'Avery'],          // us
    ['jordan@harborline.example', 'Jordan'],        // our domain
    ['dana.whit@fernpoint.example', 'Dana'],        // already a person
    ['lena@fernpoint.example', 'Lena Fischer'],     // new person, company we hold
    ['marcus.bell@cobalt.example', ''],             // new person, name off the address, new company
    ['info@cobalt.example', ''],                    // role mailbox: never a person
    ['x7@lumen.example', ''],                       // no readable name: never a person
    ['sam@gmail.com', 'Sam Ortiz'],                 // new person, free mail: no company
  ]);
  assert.deepEqual(await newFromNotetakers(db, 'ws', attendees), { people: 3, accounts: 1 });
  assert.deepEqual(await newFromNotetakers(db, 'ws', new Map()), { people: 0, accounts: 0 });
});

// ── Fathom, the other note-taker the backfill replays (GET-817) ───────────────────────────────
import { tallyFathomPage, mergeAttendees } from '../src/lib/historyCount.mjs';

test('a Fathom page counts the meetings in the window, their length in credits, and who was invited', () => {
  const from = Date.parse('2026-09-01T00:00:00Z');
  const tally = { meetings: 0, credits: 0, attendees: new Map() };
  const more = tallyFathomPage([
    { recording_start_time: '2026-10-01T10:00:00Z', recording_end_time: '2026-10-01T10:25:00Z',
      calendar_invitees: [{ email: 'Lena@Fernpoint.example', name: 'Lena Fischer' }, { email: 'avery@harborline.example', name: '' }] },
    { scheduled_start_time: '2026-09-15T09:00:00Z', calendar_invitees: [{ email: 'lena@fernpoint.example', name: '' }, { name: 'No Address' }] },
    { recording_start_time: '2026-08-20T09:00:00Z', recording_end_time: '2026-08-20T10:00:00Z',
      calendar_invitees: [{ email: 'old@cobalt.example', name: 'Old Call' }] },
  ], from, tally);
  assert.equal(tally.meetings, 2);
  // 25 minutes → 3, no recording length → 30 minutes → 3; the August call is outside the window.
  assert.equal(tally.credits, 2 * (3 + 3));
  assert.deepEqual([...tally.attendees], [['lena@fernpoint.example', 'Lena Fischer'], ['avery@harborline.example', '']]);
  assert.equal(more, true, 'one old meeting mid-list does not end the paging; the list is not strictly by start');
  assert.equal(tallyFathomPage([{ scheduled_start_time: '2026-08-01T10:00:00Z' }, { recording_start_time: '2026-07-01T10:00:00Z' }], from, tally), false,
    'a page old all through ends it');
  assert.equal(tally.meetings, 2);
  assert.equal(tallyFathomPage([], from, tally), true);
});

test('attendees from both note-takers merge by address, keeping a name either had', () => {
  const merged = mergeAttendees(new Map([['a@x.example', ''], ['b@y.example', 'Bea']]), null, new Map([['a@x.example', 'Ann'], ['b@y.example', '']]));
  assert.deepEqual([...merged], [['a@x.example', 'Ann'], ['b@y.example', 'Bea']]);
  assert.equal(mergeAttendees(null, new Map()), null);
});
