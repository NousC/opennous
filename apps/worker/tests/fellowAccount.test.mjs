// Which dealership a Fellow call is filed on (GET-296).
//
// The rule these pin: the account is the company owning the email domain the most external
// attendees share; free mail never matches by domain; and with nothing to match on, the CRM's
// employer still wins so a workspace without domains behaves as it always did.
//
// The first two cases are shaped like the Harborline misfilings that exposed the bug (every name
// invented). Both were filed on a dealership whose domain appears nowhere in the room.
//
// Pure: no database, no network.
//
// Run: node --test apps/worker/tests/fellowAccount.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAccountEntityId } from '../src/webhooks/handlers/fellow.mjs';

const ext = (email, companyId, contactId = `c:${email}`) => ({ email, companyId, contactId });

test('a stale CRM employer loses to the attendee\'s own domain', () => {
  // "Lumen Quote — Kickoff — Corriemoor Kia". tvanloo@corriemoorkia.example, whose
  // CRM row points at the sibling store Saltmarsh Kia (saltmarshkia.example).
  const externals = [ext('tvanloo@corriemoorkia.example', 'saltmarsh-kia')];
  const byDomain = new Map([['corriemoorkia.example', 'corriemoor-kia']]);
  assert.equal(pickAccountEntityId(externals, byDomain), 'corriemoor-kia');
});

test('the room outvotes one wrong row', () => {
  // "Ottercliff Auto Sales | review" landed on Fallowmere Volkswagen — a fourth company whose
  // domain is in nobody's address — because Sorrel sorted first and her row was stale.
  const externals = [
    ext('sorrel@ottercliff.example', 'fallowmere-vw'),          // stale row, listed first
    ext('tobiah@ottercliff.example', 'ottercliff-store'),
    ext('sorrel@ottercliff-autogroup.example', 'ottercliff-group'),
  ];
  const byDomain = new Map([
    ['ottercliff.example', 'ottercliff-store'],
    ['ottercliff-autogroup.example', 'ottercliff-group'],
  ]);
  // Two of three attendees are on ottercliff.example, so that is the account.
  assert.equal(pickAccountEntityId(externals, byDomain), 'ottercliff-store');
});

test('free mail never matches by domain, so the contact record still decides', () => {
  // "Onboarding call…" → Quillmoor RV is CORRECT: its free-mail address matched a known contact.
  // (The gmail.com local part is an obviously fake placeholder; the case needs gmail.com itself.)
  // Were gmail.com allowed to resolve, every free-mail dealer would collapse onto one account.
  const externals = [ext('test.dealer.0003@gmail.com', 'quillmoor-rv')];
  const byDomain = new Map([['gmail.com', 'some-google-entity']]);
  assert.equal(pickAccountEntityId(externals, byDomain), 'quillmoor-rv');
});

test('no domain resolves: the CRM employer, exactly as before', () => {
  const externals = [ext('wilmot@quenby-trailers.example', 'quenby-trailers')];
  assert.equal(pickAccountEntityId(externals, new Map()), 'quenby-trailers');
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
  const externals = [ext(null, 'crm-fallback'), ext('real@dealer.example', null)];
  const byDomain = new Map([['dealer.example', 'dealer']]);
  assert.equal(pickAccountEntityId(externals, byDomain), 'dealer');
});

// ── the group, or one of its rooftops (GET-296 follow-up) ────────────────────
//
// The domain rule alone files every Brindlecrest employee on Brindlecrest Auto Group, because that is the
// domain they all write from. On the first workspace to hit this, a large share of the contacts the
// rule moves are that shape — a group domain on a rooftop's employee — so filing by domain alone put
// all of them one level too high. Hierarchy, synced from the CRM, settles it.

const BRINDLECREST = 'brindlecrest-group', NORTH_STORE = 'brindlecrest-north';
const brindlecrestParents = new Map([[NORTH_STORE, BRINDLECREST]]);

test('a rooftop employee on the group domain files on the ROOFTOP, not the group', () => {
  // fenella.osgood@brindlecrestautogroup.example, whose CRM row says Brindlecrest Chevrolet (North Store).
  // Both answers are true; the rooftop is where the deal lives.
  const externals = [ext('fenella.osgood@brindlecrestautogroup.example', NORTH_STORE)];
  const byDomain = new Map([['brindlecrestautogroup.example', BRINDLECREST]]);
  assert.equal(pickAccountEntityId(externals, byDomain, brindlecrestParents), NORTH_STORE);
});

test('a CRM row from ANOTHER family still loses to the room — GET-296 stays fixed', () => {
  // Fallowmere Volkswagen is not part of Ottercliff. The room wins, hierarchy or not.
  const externals = [
    ext('sorrel@ottercliff.example', 'fallowmere-vw'),
    ext('tobiah@ottercliff.example', 'ottercliff-store'),
  ];
  const byDomain = new Map([['ottercliff.example', 'ottercliff-store']]);
  const parents = new Map([['brindlecrest-north', 'brindlecrest-group']]);   // unrelated hierarchy, present but irrelevant
  assert.equal(pickAccountEntityId(externals, byDomain, parents), 'ottercliff-store');
});

test('with no hierarchy synced the rule is exactly what it was before', () => {
  // Every workspace on the day this ships, and every workspace whose CRM models no groups.
  const externals = [ext('fenella.osgood@brindlecrestautogroup.example', NORTH_STORE)];
  const byDomain = new Map([['brindlecrestautogroup.example', BRINDLECREST]]);
  assert.equal(pickAccountEntityId(externals, byDomain), BRINDLECREST);
  assert.equal(pickAccountEntityId(externals, byDomain, new Map()), BRINDLECREST);
});
