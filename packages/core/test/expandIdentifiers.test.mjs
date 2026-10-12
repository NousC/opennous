// A LinkedIn identity arrives in three shapes and identity matching is exact, so
// two records can hold the same fact and never meet:
//
//   linkedin_member_id = rowanachterberg                        (a vanity handle)
//   linkedin_member_id = ACoAAExampleMemberUrn00000000000000TEST  (a member URN; made up)
//   linkedin_url       = https://www.linkedin.com/in/rowanachterberg
//
// Most member_id values in a typical workspace are handles, not URNs.
// expandIdentifiers emits the URL a handle implies, so the two spellings resolve
// to each other.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/expandIdentifiers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandIdentifiers, normaliseIdentifier } from '../dist/db/entities.js';

const urls = (ids) => expandIdentifiers(ids).filter(i => i.kind === 'linkedin_url').map(i => i.value);

test('a vanity handle in member_id implies its profile URL', () => {
  assert.deepEqual(
    urls([{ kind: 'linkedin_member_id', value: 'rowanachterberg' }]),
    ['https://www.linkedin.com/in/rowanachterberg'],
  );
});

test('a member URN implies no URL — /in/ACoAA… is not a public profile', () => {
  assert.deepEqual(urls([{ kind: 'linkedin_member_id', value: 'ACoAAExampleMemberUrn00000000000000TEST' }]), []);
});

test('the derived URL is canonical, so it matches a stored one', () => {
  const [derived] = urls([{ kind: 'linkedin_member_id', value: 'Rowan-Achterberg' }]);
  assert.equal(derived, normaliseIdentifier('linkedin_url', 'https://linkedin.com/in/Rowan-Achterberg/'));
});

test('no duplicate when the caller already sent the URL', () => {
  const out = urls([
    { kind: 'linkedin_member_id', value: 'rowanachterberg' },
    { kind: 'linkedin_url', value: 'https://www.linkedin.com/in/rowanachterberg/' },
  ]);
  assert.equal(out.length, 1);
});

test('implausible handles are left alone rather than turned into junk URLs', () => {
  assert.deepEqual(urls([{ kind: 'linkedin_member_id', value: 'a' }]), []);          // too short
  assert.deepEqual(urls([{ kind: 'linkedin_member_id', value: 'has space' }]), []);
  assert.deepEqual(urls([{ kind: 'linkedin_member_id', value: 'x@y.example' }]), []);
});

test('the original identifiers always survive expansion', () => {
  const input = [
    { kind: 'email', value: 'rowan@harborline-group.example' },
    { kind: 'linkedin_member_id', value: 'rowanachterberg' },
  ];
  const out = expandIdentifiers(input);
  for (const i of input) {
    assert.ok(out.some(o => o.kind === i.kind && o.value === i.value), `${i.kind} survived`);
  }
});

test('non-LinkedIn identifiers pass through untouched', () => {
  const input = [{ kind: 'email', value: 'a@b.example' }, { kind: 'apollo', value: 'xyz' }];
  assert.deepEqual(expandIdentifiers(input), input);
});

// ── the canonical form itself ────────────────────────────────────────────────
// These are the shapes actually sitting in production: many person profiles with
// a trailing slash, and many not lowercased.

test('normaliseIdentifier collapses the shapes that forked Rowan Achterberg', () => {
  const canonical = 'https://www.linkedin.com/in/rowanachterberg';
  for (const variant of [
    'https://www.linkedin.com/in/rowanachterberg',
    'https://www.linkedin.com/in/rowanachterberg/',
    'https://linkedin.com/in/RowanAchterberg',
    'http://www.linkedin.com/in/rowanachterberg/',
    'linkedin.com/in/rowanachterberg',
  ]) {
    assert.equal(normaliseIdentifier('linkedin_url', variant), canonical, variant);
  }
});

test('a company page is not a person profile and is left as-is', () => {
  // Plenty of these exist; mangling them into /in/ URLs would invent identities.
  const page = 'https://www.linkedin.com/company/harborline';
  assert.equal(normaliseIdentifier('linkedin_url', page), page);
});

// ── app and database must agree ──────────────────────────────────────────────
// A BEFORE INSERT trigger runs normalise_identifier() on every write. If the JS
// normaliser used for LOOKUPS disagrees with it, the stored value and the looked-up
// value differ and every match misses. These mirror the SQL function's rules.

test('member_id: a vanity handle folds to lowercase, as the DB trigger stores it', () => {
  assert.equal(normaliseIdentifier('linkedin_member_id', 'RowanAchterberg'), 'rowanachterberg');
});

test('member_id: a URN is case-sensitive and is never lowercased', () => {
  const urn = 'ACoAAExampleMemberUrn00000000000000TEST';
  assert.equal(normaliseIdentifier('linkedin_member_id', urn), urn);
});

test('email: a malformed value is not an identifier', () => {
  for (const bad of ['a@b.example,c@d.example', 'd', 'kk', 'no-at-sign.example', 'x@y']) {
    assert.equal(normaliseIdentifier('email', bad), null, bad);
  }
  assert.equal(normaliseIdentifier('email', '  Rowan@Harborline-Group.EXAMPLE '), 'rowan@harborline-group.example');
});

test('linkedin_url: a member URN in the /in/ slot keeps its case — it is an id, not a handle', () => {
  const urn = 'https://www.linkedin.com/in/ACoAAA0000000000000000000000000000000';
  assert.equal(normaliseIdentifier('linkedin_url', urn), urn);
  assert.equal(normaliseIdentifier('linkedin_url', urn + '/'), urn);
});

test('linkedin_url: a vanity handle still folds to lowercase', () => {
  assert.equal(normaliseIdentifier('linkedin_url', 'https://linkedin.com/in/Jordan-Reed42/'),
    'https://www.linkedin.com/in/jordan-reed42');
});
