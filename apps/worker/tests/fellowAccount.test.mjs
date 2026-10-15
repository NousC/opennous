// Which customer company a Fellow call is filed on (GET-296).
//
// The rule these pin: the account is the company owning the email domain the most external
// attendees share; free mail never matches by domain; and with nothing to match on, the CRM's
// employer still wins so a workspace without domains behaves as it always did.
//
// The first two cases are shaped like the Harborline misfilings that exposed the bug (every name
// invented). Both were filed on a company whose domain appears nowhere in the room.
//
// Pure: no database, no network.
//
// Run: node --test apps/worker/tests/fellowAccount.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAccountEntityId } from '../src/webhooks/handlers/fellow.mjs';

const ext = (email, companyId, contactId = `c:${email}`) => ({ email, companyId, contactId });

test('a stale CRM employer loses to the attendee\'s own domain', () => {
  // "Lumen Quote — Kickoff — Corriemoor Labs". tvanloo@corriemoorlabs.example, whose
  // CRM row points at the sibling office Saltmarsh Labs (saltmarshlabs.example).
  const externals = [ext('tvanloo@corriemoorlabs.example', 'saltmarsh-labs')];
  const byDomain = new Map([['corriemoorlabs.example', 'corriemoor-labs']]);
  assert.equal(pickAccountEntityId(externals, byDomain), 'corriemoor-labs');
});

test('the room outvotes one wrong row', () => {
  // "Ottercliff Software | review" landed on Fallowmere Software — a fourth company whose
  // domain is in nobody's address — because Sorrel sorted first and her row was stale.
  const externals = [
    ext('sorrel@ottercliff.example', 'fallowmere-sw'),          // stale row, listed first
    ext('tobiah@ottercliff.example', 'ottercliff-store'),
    ext('sorrel@ottercliff-group.example', 'ottercliff-group'),
  ];
  const byDomain = new Map([
    ['ottercliff.example', 'ottercliff-store'],
    ['ottercliff-group.example', 'ottercliff-group'],
  ]);
  // Two of three attendees are on ottercliff.example, so that is the account.
  assert.equal(pickAccountEntityId(externals, byDomain), 'ottercliff-store');
});

test('free mail never matches by domain, so the contact record still decides', () => {
  // "Onboarding call…" → Quillmoor Logistics is CORRECT: its free-mail address matched a known contact.
  // (The gmail.com local part is an obviously fake placeholder; the case needs gmail.com itself.)
  // Were gmail.com allowed to resolve, every free-mail customer would collapse onto one account.
  const externals = [ext('test.customer.0003@gmail.com', 'quillmoor-logistics')];
  const byDomain = new Map([['gmail.com', 'some-google-entity']]);
  assert.equal(pickAccountEntityId(externals, byDomain), 'quillmoor-logistics');
});

test('no domain resolves: the CRM employer, exactly as before', () => {
  const externals = [ext('wilmot@quenby-supply.example', 'quenby-supply')];
  assert.equal(pickAccountEntityId(externals, new Map()), 'quenby-supply');
  // And with no employer either, the person is better than nothing.
  assert.equal(pickAccountEntityId([ext('a@b.example', null, 'contact-1')], new Map()), 'contact-1');
});

test('a tie falls to whoever was in the room first, so the answer is order-stable', () => {
  const a = ext('one@alpha.example', null), b = ext('two@beta.example', null);
  const byDomain = new Map([['alpha.example', 'alpha'], ['beta.example', 'beta']]);
  assert.equal(pickAccountEntityId([a, b], byDomain), 'alpha');
  assert.equal(pickAccountEntityId([b, a], byDomain), 'beta');
});

test('no externals is null, never a guess', () => {
  assert.equal(pickAccountEntityId([], new Map()), null);
  assert.equal(pickAccountEntityId(null, new Map()), null);
});

test('an attendee with no email is skipped, not counted', () => {
  const externals = [ext(null, 'crm-fallback'), ext('real@customer.example', null)];
  const byDomain = new Map([['customer.example', 'customer']]);
  assert.equal(pickAccountEntityId(externals, byDomain), 'customer');
});

// ── the group, or one of its subsidiaries (GET-296 follow-up) ────────────────
//
// The domain rule alone files every Brindlecrest employee on Brindlecrest Group, because that is the
// domain they all write from. On the first workspace to hit this, a large share of the contacts the
// rule moves are that shape — a group domain on a subsidiary's employee — so filing by domain alone put
// all of them one level too high. Hierarchy, synced from the CRM, settles it.

const BRINDLECREST = 'brindlecrest-group', NORTH_STORE = 'brindlecrest-north';
const brindlecrestParents = new Map([[NORTH_STORE, BRINDLECREST]]);

test('a subsidiary employee on the group domain files on the SUBSIDIARY, not the group', () => {
  // fenella.osgood@brindlecrestgroup.example, whose CRM row says Brindlecrest (North Office).
  // Both answers are true; the subsidiary is where the deal lives.
  const externals = [ext('fenella.osgood@brindlecrestgroup.example', NORTH_STORE)];
  const byDomain = new Map([['brindlecrestgroup.example', BRINDLECREST]]);
  assert.equal(pickAccountEntityId(externals, byDomain, brindlecrestParents), NORTH_STORE);
});

test('a CRM row from ANOTHER family still loses to the room — GET-296 stays fixed', () => {
  // Fallowmere Software is not part of Ottercliff. The room wins, hierarchy or not.
  const externals = [
    ext('sorrel@ottercliff.example', 'fallowmere-sw'),
    ext('tobiah@ottercliff.example', 'ottercliff-store'),
  ];
  const byDomain = new Map([['ottercliff.example', 'ottercliff-store']]);
  const parents = new Map([['brindlecrest-north', 'brindlecrest-group']]);   // unrelated hierarchy, present but irrelevant
  assert.equal(pickAccountEntityId(externals, byDomain, parents), 'ottercliff-store');
});

test('with no hierarchy synced the rule is exactly what it was before', () => {
  // Every workspace on the day this ships, and every workspace whose CRM models no groups.
  const externals = [ext('fenella.osgood@brindlecrestgroup.example', NORTH_STORE)];
  const byDomain = new Map([['brindlecrestgroup.example', BRINDLECREST]]);
  assert.equal(pickAccountEntityId(externals, byDomain), BRINDLECREST);
  assert.equal(pickAccountEntityId(externals, byDomain, new Map()), BRINDLECREST);
});
