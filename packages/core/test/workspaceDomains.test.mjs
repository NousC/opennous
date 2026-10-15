// Which domains belong to the workspace itself (GET-291).
//
// This rule decides whether a company's whole staff becomes "internal" — excluded from scoring,
// from lead lists, from being treated as a buyer. Wrong in one direction and a client's own CS
// manager is read as a customer (four bugs on 2026-09-17). Wrong in the other and a real customer's
// staff vanish from the pipeline. So: two independent sources, or a person's say-so.
//
// Run: node --test packages/core/test/workspaceDomains.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualifyingDomains, isOwnEmail } from '../dist/db/workspaceDomains.js';

const c = (domain, sources, evidence = []) => ({ domain, sources, evidence });

test('two independent sources agreeing is enough — the Harborline case', () => {
  const out = qualifyingDomains([
    c('harborline.example', ['seat', 'source_account'], ['rowan@harborline.example', 'nous@harborline.example']),
  ]);
  assert.deepEqual(out.map(o => o.domain), ['harborline.example']);
});

test('one source alone is a coincidence, not a fact', () => {
  // A single contractor seat on a client's domain must not make that client's whole staff internal.
  assert.deepEqual(qualifyingDomains([c('bigclient.example', ['seat'])]), []);
  assert.deepEqual(qualifyingDomains([c('bigclient.example', ['source_account'])]), []);
});

test('the same source twice is still one source', () => {
  assert.deepEqual(qualifyingDomains([c('acme.example', ['seat', 'seat'])]), []);
});

test('a person saying so is enough on its own', () => {
  const out = qualifyingDomains([c('acme.example', ['manual'])]);
  assert.deepEqual(out.map(o => o.domain), ['acme.example']);
});

test('several candidates are judged one at a time', () => {
  const out = qualifyingDomains([
    c('harborline.example', ['seat', 'source_account']),
    c('someclient.example', ['seat']),
    c('acquired-brand.example', ['manual']),
  ]);
  assert.deepEqual(out.map(o => o.domain).sort(), ['acquired-brand.example', 'harborline.example']);
});

test('nothing in, nothing out', () => {
  assert.deepEqual(qualifyingDomains([]), []);
  assert.deepEqual(qualifyingDomains(null), []);
});

test('an address on a known domain is ours', () => {
  const ours = new Set(['harborline.example']);
  assert.equal(isOwnEmail('lena@harborline.example', ours), true);
  assert.equal(isOwnEmail('LENA@Harborline.example', ours), true);
  assert.equal(isOwnEmail('pim@thistlecombehealth.example', ours), false);
});

test('knowing no domains means claiming nobody, never claiming everybody', () => {
  // The dangerous direction: an empty or missing set must not read as "everyone is ours".
  assert.equal(isOwnEmail('lena@harborline.example', new Set()), false);
  assert.equal(isOwnEmail('lena@harborline.example', null), false);
  assert.equal(isOwnEmail('lena@harborline.example', undefined), false);
  assert.equal(isOwnEmail('lena@harborline.example', ['harborline.example']), false);   // not a Set: not trusted
});

test('nonsense addresses are nobody', () => {
  const ours = new Set(['harborline.example']);
  assert.equal(isOwnEmail('', ours), false);
  assert.equal(isOwnEmail(null, ours), false);
  assert.equal(isOwnEmail('not-an-address', ours), false);
});
