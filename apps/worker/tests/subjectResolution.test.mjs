// Who is this fact ABOUT? — the guard on every LLM pass that writes prose about a person.
//
// `contacts` is a view over `claims`, and claims are derived by a cron that ticks
// once a minute, while the extractors fire setImmediate off the observation write.
// So on a brand-new contact the view answers with nulls for a name the ingest
// already wrote. That window put a sender's own cold pitch into the record as
// facts about the person she was pitching, because the prompt orders the model to
// name its subject and the only proper noun available was the greeting.
//
// Run: node --test apps/worker/tests/subjectResolution.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSubject } from '../src/signals/index.mjs';

const NOW = '2026-09-11T17:38:50.130Z';

/** Minimal supabase double: one `contacts` row (the lagging projection) and a
 *  list of `observations` (what the ingest actually wrote). */
function fakeSupabase({ view = {}, observations = [], onViewRead } = {}) {
  let reads = 0;
  return {
    reads: () => reads,
    from(table) {
      if (table === 'contacts') {
        const q = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => {
            reads += 1;
            const row = onViewRead ? onViewRead(reads) : view;
            return { data: row, error: null };
          },
        };
        return q;
      }
      if (table === 'observations') {
        const q = {
          select: () => q,
          eq: () => q,
          in: (_col, props) => { q._props = props; return q; },
          order: async () => ({
            data: observations.filter(o => q._props.includes(o.property)),
            error: null,
          }),
        };
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const obs = (property, value, observed_at = NOW) => ({ property, value, observed_at });
const FAST = { retries: 2, retryMs: 0 };

test('the view has the name — resolved on the first pass, no retry', async () => {
  const sb = fakeSupabase({ view: { first_name: 'Odessa', last_name: 'T.', company: null } });
  const s = await loadSubject(sb, 'c1', '', FAST);
  assert.equal(s.name, 'Odessa T.');
  assert.equal(sb.reads(), 1);
});

test('the projection lags — the name comes from the observations the ingest wrote', async () => {
  const sb = fakeSupabase({
    view: { first_name: null, last_name: null, company: null },
    observations: [obs('first_name', 'Odessa'), obs('last_name', 'T.')],
  });
  const s = await loadSubject(sb, 'c1', '', FAST);
  assert.equal(s.name, 'Odessa T.');
});

test('observations only fill gaps — a value already in the view wins', async () => {
  const sb = fakeSupabase({
    view: { first_name: 'Odessa', last_name: null, company: 'Acme' },
    observations: [obs('first_name', 'STALE'), obs('last_name', 'T.'), obs('company', 'STALE CO')],
  });
  const s = await loadSubject(sb, 'c1', '', FAST);
  assert.equal(s.name, 'Odessa T.');
  assert.equal(s.company, 'Acme');
});

test('newest observation wins for a property', async () => {
  const sb = fakeSupabase({
    view: {},
    observations: [
      obs('first_name', 'Odessa', '2026-09-11T17:38:50.130Z'),
      obs('first_name', 'F.',   '2026-09-11T17:30:00.000Z'),
    ],
  });
  assert.equal((await loadSubject(sb, 'c1', '', FAST)).name, 'Odessa');
});

test('full_name alone is a subject', async () => {
  const sb = fakeSupabase({ view: {}, observations: [obs('full_name', 'Rosalind Ebberly')] });
  assert.equal((await loadSubject(sb, 'c1', '', FAST)).name, 'Rosalind Ebberly');
});

test('an email is NOT a subject — it cannot be the grammatical subject of a fact', async () => {
  const sb = fakeSupabase({ view: {}, observations: [obs('email', 'rosalind@ebberly.example')] });
  assert.equal(await loadSubject(sb, 'c1', '', FAST), null);
});

test('no name anywhere returns null rather than a placeholder', async () => {
  const sb = fakeSupabase({ view: {}, observations: [] });
  assert.equal(await loadSubject(sb, 'c1', '', FAST), null);
});

test('a name still in flight is caught by the retry', async () => {
  const sb = fakeSupabase({
    onViewRead: (n) => (n >= 3 ? { first_name: 'Odessa', last_name: 'T.' } : {}),
  });
  const s = await loadSubject(sb, 'c1', '', FAST);
  assert.equal(s.name, 'Odessa T.');
  assert.equal(sb.reads(), 3);
});

test('blank strings in the view are not a name', async () => {
  const sb = fakeSupabase({
    view: { first_name: '  ', last_name: '' },
    observations: [obs('first_name', 'Odessa')],
  });
  assert.equal((await loadSubject(sb, 'c1', '', FAST)).name, 'Odessa');
});

// ── the subject guard ────────────────────────────────────────────────────────
// The mechanical half of the fix. loadSubject stops the nameless case upstream;
// this is what holds when a named extractor still writes about somebody else —
// the greeting, a teammate in a quoted reply header, the loudest speaker on a call.

import { namesSubjectForTest } from '../src/signals/index.mjs';

test('a fact naming its subject passes', () => {
  assert.equal(namesSubjectForTest('Odessa T. is a Full-Stack MERN engineer.', 'Odessa T.'), true);
});

test('a fact naming the person the message GREETS is rejected', () => {
  assert.equal(namesSubjectForTest('Theo is a Full-Stack MERN engineer.', 'Odessa T.'), false);
});

test('the placeholder subject is rejected', () => {
  assert.equal(namesSubjectForTest('The contact is building Quorvane, a GTM platform.', 'Imogen Tarrant'), false);
});

test("another attendee's facts are rejected", () => {
  assert.equal(namesSubjectForTest('Lorcan moved from spreadsheets to a workflow tool last spring.', 'Rose Ellen Varnsworth'), false);
});

test('a surname alone names the subject', () => {
  assert.equal(namesSubjectForTest('Marchbank asked to be removed from the list.', 'Hollis Marchbank'), true);
});

test('a partial given name names the subject — "Rose Ellen Varnsworth" written "Rose Ellen"', () => {
  assert.equal(namesSubjectForTest('Rose Ellen runs revenue ops for the Lisbon team.', 'Rose Ellen Varnsworth'), true);
});

test('a 2-character name token does not count as naming anyone', () => {
  // "Edmund K" — the "K" must not match every fact containing a letter k.
  assert.equal(namesSubjectForTest('Lorcan worked at a bank for ten years.', 'Edmund K'), false);
});

test('with no resolved name the guard abstains rather than dropping everything', () => {
  assert.equal(namesSubjectForTest('Someone said something.', null), true);
});
