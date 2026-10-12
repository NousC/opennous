// A job title is an attribute, not a claim (GET-327 test 5, applied to people).
//
// In the first month of Gmail extraction, most `general` + `authority` claims were a person's
// role — the same sentence shape, "X is the General Manager at Y", split between general and
// authority on nothing anyone could name. Neither category is wrong, which is the problem:
// the fact does not belong in either, because it is not something someone said and it does not
// decay. It is what the person IS.
//
// `job_title` is already a first-class person property, filled in bulk from the CRM. An email
// signature is a better source than a CRM field nobody updates.
//
// Run: node --test apps/worker/tests/jobTitleAttribute.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { persistJobTitles } from '../src/signals/index.mjs';

const dry = (facts) => persistJobTitles(null, 'ws', facts, { source: 'gmail', dryRun: true });

test('a title on a fact is filed as an attribute', async () => {
  assert.equal(await dry([{ contactId: 'c1', job_title: 'General Sales Manager' }]), 1);
});

test('one title per contact, however many times it is mentioned', async () => {
  // A thread repeats a signature block in every message. That is one title, not four.
  const n = await dry([
    { contactId: 'c1', job_title: 'General Manager' },
    { contactId: 'c1', job_title: 'General Manager' },
    { contactId: 'c1', job_title: 'GM' },
    { contactId: 'c2', job_title: 'Finance Manager' },
  ]);
  assert.equal(n, 2, 'two contacts, two titles');
});

test('a sentence is not a title — that is the model narrating', async () => {
  // The failure this guards: "Gideon Harrowby is the General Manager at Pinecastle Nissan and handles
  // all tooling decisions" is a CLAIM the model has stuffed into the title field.
  assert.equal(await dry([{ contactId: 'c1',
    job_title: 'the General Manager at Pinecastle Nissan who handles all tooling decisions' }]), 0);
});

test('nothing to file when there is no title, no contact, or it is junk', async () => {
  assert.equal(await dry([]), 0);
  assert.equal(await dry([{ contactId: 'c1' }]), 0);
  assert.equal(await dry([{ contactId: 'c1', job_title: '   ' }]), 0);
  assert.equal(await dry([{ contactId: 'c1', job_title: 'X' }]), 0, 'a single letter is not a role');
  assert.equal(await dry([{ job_title: 'General Manager' }]), 0, 'no contact to file it against');
  assert.equal(await dry([{ contactId: 'c1', job_title: 42 }]), 0);
});

test('titles are filed independently of whether the claim survives', async () => {
  // persistFacts files titles BEFORE the pronoun and subject guards run, deliberately: a title is
  // an attribute of the person and does not depend on the claim it arrived with being keepable.
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../src/signals/index.mjs', import.meta.url), 'utf8'));
  const body = src.slice(src.indexOf('export async function persistFacts'));
  const titleAt = body.indexOf('persistJobTitles');
  const guardAt = body.indexOf('violatesPronounRule');
  assert.ok(titleAt > 0 && guardAt > 0);
  assert.ok(titleAt < guardAt, 'titles must be filed before the claim guards can drop the fact');
});
