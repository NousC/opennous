// A commitment sits on the account. An email sits on a person.
//
// Both are right, and together they meant this engine's most common rule — you promised to email
// them, and an email to them followed — could never fire on anything a meeting produced. Measured
// in prod before the fix: dozens of open commitments, about half matching the email verb, **0**
// closable. Every entity carrying meeting tasks was a company; nearly every email_sent row was on a person.
//
// Nothing errored. A task list that never closes looks exactly like a team that never follows up,
// and the first person to notice would have blamed the reps.
//
// Run: node --test apps/api/tests/actionItemClosure.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personNamedIn, autoCloseActionItems, promisedAtOf } from '@nous/core';

// ── the naming rule ──────────────────────────────────────────────────────────

const NED = { id: 'p-ned', first_name: 'Ned', last_name: 'Ashdown' };
const TAMSIN = { id: 'p-tamsin', first_name: 'Tamsin', last_name: 'Brightwater' };
const OSRIC_P = { id: 'p-osric-p', first_name: 'Osric', last_name: 'Pemberly' };
const OSRIC_H = { id: 'p-osric-h', first_name: 'Osric', last_name: 'Halloway' };

test('a promise naming one person narrows to that person', () => {
  assert.equal(personNamedIn('Send Ned the CSV mapping fix', [NED, TAMSIN]), 'p-ned');
  assert.equal(personNamedIn('Follow up with Tamsin Brightwater about pricing', [NED, TAMSIN]), 'p-tamsin');
});

test('a promise naming nobody stays open to the whole account', () => {
  // The common case by far, and the reason widening to the account is the right default.
  assert.equal(personNamedIn('Send the pricing sheet', [NED, TAMSIN]), null);
  assert.equal(personNamedIn('Fix the mobile layout', [NED, TAMSIN]), null);
});

test('two people of the same name resolve to nobody, never to a guess', () => {
  // Two people called Osric at one customer: we cannot tell who was meant, and widening to the account is a
  // smaller error than closing against the wrong person.
  assert.equal(personNamedIn('Send Osric the deck', [OSRIC_P, OSRIC_H]), null);
  // Full name disambiguates.
  assert.equal(personNamedIn('Send Osric Halloway the deck', [OSRIC_P, OSRIC_H]), 'p-osric-h');
});

test('a short first name is not evidence of anything', () => {
  // "Al" and "Jo" appear inside ordinary words and sentences constantly.
  assert.equal(personNamedIn('Send the proposal', [{ id: 'p-al', first_name: 'Al', last_name: 'Reed' }]), null);
});

test('punctuation does not hide a name', () => {
  assert.equal(personNamedIn('Send Ned, the CSV mapping fix.', [NED]), 'p-ned');
  assert.equal(personNamedIn('Email "Ned" re: CSV mapping', [NED]), 'p-ned');
});

test('nothing in, nothing out', () => {
  assert.equal(personNamedIn('', [NED]), null);
  assert.equal(personNamedIn(null, [NED]), null);
  assert.equal(personNamedIn('Send Ned the fix', []), null);
  assert.equal(personNamedIn('Send Ned the fix'), null);
});

// ── the closure itself, over an account's people ─────────────────────────────

const DAY = 86_400_000;
const at = (d) => new Date(Date.now() - d * DAY).toISOString();

/** Supabase stub: each table answers from a fixture; updates are captured. */
function db(fx, captured = []) {
  const make = (table) => {
    const q = {
      select: () => q, eq: () => q, in: () => q, is: () => q, like: () => q, not: () => q,
      or: () => q, gte: () => q, lt: () => q, order: () => q,
      update(v) { q._update = v; return q; },
      limit: () => Promise.resolve({ data: fx[table] ?? [], error: null }),
      range: () => Promise.resolve({ data: fx[table] ?? [], error: null }),
      then: (res) => {
        if (q._update) { captured.push(q._update); return res({ data: null, error: null }); }
        return res({ data: fx[table] ?? [], error: null });
      },
    };
    return q;
  };
  return { from: make };
}

const COMMITMENT = {
  id: 'c1', entity_id: 'acct1', property: 'action_item.meeting_m1_0',
  computed_at: at(10),
  value: { title: 'Send the CSV mapping fix', status: 'open', owner_kind: 'user', recorded_at: at(10) },
};

test('an email to a person at the account closes the account\'s commitment', async () => {
  // The whole bug, in one assertion: before this, evidence was looked for on `acct1` alone and
  // the account row never carries an email.
  const closed = await autoCloseActionItems(db({
    claims: [COMMITMENT],
    contacts: [{ id: 'p-ned', company_id: 'acct1', first_name: 'Ned', last_name: 'Ashdown' }],
    observations: [{ entity_id: 'p-ned', property: 'interaction.email_sent', observed_at: at(3), source: 'gmail' }],
  }), 'ws');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].title, 'Send the CSV mapping fix');
});

test('evidence before the promise does not discharge it', async () => {
  const closed = await autoCloseActionItems(db({
    claims: [COMMITMENT],
    contacts: [{ id: 'p-ned', company_id: 'acct1', first_name: 'Ned', last_name: 'Ashdown' }],
    observations: [{ entity_id: 'p-ned', property: 'interaction.email_sent', observed_at: at(30), source: 'gmail' }],
  }), 'ws');
  assert.equal(closed.length, 0, 'an email you sent last month does not keep a promise made last week');
});

test('mailing a colleague does not keep a promise made to someone named', async () => {
  // "I'll send Ned the CSV mapping fix" is not discharged by emailing the receptionist.
  const closed = await autoCloseActionItems(db({
    claims: [{ ...COMMITMENT, value: { ...COMMITMENT.value, title: 'Send Ned the CSV mapping fix' } }],
    contacts: [
      { id: 'p-ned', company_id: 'acct1', first_name: 'Ned', last_name: 'Ashdown' },
      { id: 'p-recep', company_id: 'acct1', first_name: 'Odile', last_name: 'Brenner' },
    ],
    observations: [{ entity_id: 'p-recep', property: 'interaction.email_sent', observed_at: at(3), source: 'gmail' }],
  }), 'ws');
  assert.equal(closed.length, 0);
});

test('mailing the person named does keep it', async () => {
  const closed = await autoCloseActionItems(db({
    claims: [{ ...COMMITMENT, value: { ...COMMITMENT.value, title: 'Send Ned the CSV mapping fix' } }],
    contacts: [
      { id: 'p-ned', company_id: 'acct1', first_name: 'Ned', last_name: 'Ashdown' },
      { id: 'p-recep', company_id: 'acct1', first_name: 'Odile', last_name: 'Brenner' },
    ],
    observations: [{ entity_id: 'p-ned', property: 'interaction.email_sent', observed_at: at(3), source: 'gmail' }],
  }), 'ws');
  assert.equal(closed.length, 1);
});

test('a commitment THEY owe is not closed by us acting', async () => {
  const closed = await autoCloseActionItems(db({
    claims: [{ ...COMMITMENT, value: { ...COMMITMENT.value, owner_kind: 'prospect' } }],
    contacts: [{ id: 'p-ned', company_id: 'acct1', first_name: 'Ned', last_name: 'Ashdown' }],
    observations: [{ entity_id: 'p-ned', property: 'interaction.email_sent', observed_at: at(3), source: 'gmail' }],
  }), 'ws');
  assert.equal(closed.length, 0);
});

// ── when the promise was made (GET-407) ──────────────────────────────────────
//
// The engine dated every promise at EXTRACTION. A June call read in September put its promises
// in September, and the emails and meetings that kept them — all between June and September —
// fell before the line. One account's signup promise from a spring call sat open months later, long since kept.

test('a task read months after the call dates its promise at the call', () => {
  const row = { computed_at: at(0), value: { occurred_at: at(110), recorded_at: at(0) } };
  const promised = promisedAtOf(row);
  assert.ok(Math.abs(promised - (Date.now() - 110 * DAY)) < 5 * 60_000, 'the call\'s date, not the extraction\'s');
});

test('a task with no occurred_at still dates at recording, then at computation', () => {
  assert.ok(Math.abs(promisedAtOf({ computed_at: at(3), value: { recorded_at: at(10) } }) - (Date.now() - 10 * DAY)) < 5 * 60_000);
  assert.ok(Math.abs(promisedAtOf({ computed_at: at(3), value: {} }) - (Date.now() - 3 * DAY)) < 5 * 60_000);
});

test('the June promise closes on the July email, not on nothing', async () => {
  // Extracted today (computed_at), said 110 days ago (occurred_at), emailed 100 days ago.
  const closed = await autoCloseActionItems(db({
    claims: [{ ...COMMITMENT, computed_at: at(0), value: { ...COMMITMENT.value, title: 'Send the data-warehouse sign-up information', occurred_at: at(110), recorded_at: at(0) } }],
    contacts: [{ id: 'p-rufus', company_id: 'acct1', first_name: 'Rufus', last_name: 'Penhallow' }],
    observations: [{ entity_id: 'p-rufus', property: 'interaction.email_sent', observed_at: at(100), source: 'hubspot' }],
  }), 'ws');
  assert.equal(closed.length, 1, 'before GET-407 this was 0: the email fell before the extraction date');
});

test('a reopened task is not re-closed on the evidence that was judged wrong', async () => {
  // Said 20 days ago, emailed 15 days ago, auto-closed, reopened by hand 10 days ago.
  const closed = await autoCloseActionItems(db({
    claims: [{ ...COMMITMENT, value: { ...COMMITMENT.value, occurred_at: at(20), recorded_at: at(20), reopened_at: at(10) } }],
    contacts: [{ id: 'p-ned', company_id: 'acct1', first_name: 'Ned', last_name: 'Ashdown' }],
    observations: [{ entity_id: 'p-ned', property: 'interaction.email_sent', observed_at: at(15), source: 'gmail' }],
  }), 'ws');
  assert.equal(closed.length, 0, 'the line moved to the reopen');
});

test('...but a new email after the reopen does close it', async () => {
  const closed = await autoCloseActionItems(db({
    claims: [{ ...COMMITMENT, value: { ...COMMITMENT.value, occurred_at: at(20), recorded_at: at(20), reopened_at: at(10) } }],
    contacts: [{ id: 'p-ned', company_id: 'acct1', first_name: 'Ned', last_name: 'Ashdown' }],
    observations: [{ entity_id: 'p-ned', property: 'interaction.email_sent', observed_at: at(5), source: 'gmail' }],
  }), 'ws');
  assert.equal(closed.length, 1);
});
