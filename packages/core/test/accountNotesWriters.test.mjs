// The account page must believe every writer, and exclude only documents.
//
// `listAccountNotes` filtered a person's claims with `source = 'signal_extraction'`. That reads as
// "extracted facts" and actually means "extracted by the worker" — so every other writer was
// defined out of the account page without anyone deciding to:
//
//   fellow / agent   the revenue plugin's `record` — everything the subagent extraction runs filed
//   fellow:health    the call health read
//
// Both produce real extracted facts, correctly filed, in rollup categories. Measured on a pilot
// workspace: hundreds of plugin-written and health facts on people, and more on companies through
// the same filter one layer up in CompanyDetailView. One account showed a handful of a much longer list.
//
// What genuinely belongs off the page is a DOCUMENT — a meeting-notes blob, which would crowd the
// facts out — and a document is exactly what carries `metadata.doc_type`.
// So the test is doc_type, not source.
//
// Run: node --test packages/core/test/accountNotesWriters.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const NOTES = readFileSync(join(here, '..', 'src', 'db', 'notes.ts'), 'utf8');
const COMPANY_VIEW = readFileSync(
  join(here, '..', '..', '..', 'apps', 'frontend', 'src', 'components', 'CompanyDetailView.tsx'), 'utf8');

const listAccountNotes = NOTES.match(/export async function listAccountNotes[\s\S]*?\n\}/);

test('listAccountNotes excludes documents, not non-worker writers', () => {
  assert.ok(listAccountNotes, 'could not find listAccountNotes');
  // Comments in the body mention the old filter on purpose (it is the thing being explained), so
  // assert on the QUERY rather than on the prose around it.
  const code = listAccountNotes[0].replace(/\/\/[^\n]*/g, '');
  assert.match(code, /\.is\('value->metadata->>doc_type', null\)/,
    'it must exclude documents — that is the thing that crowds a page');
  assert.doesNotMatch(code, /\.eq\('value->>source'/,
    'a fact must not have to come from one particular writer to reach the account page');
});

test('the company page filters on documents, not on who wrote the fact', () => {
  const intel = COMPANY_VIEW.match(/const intel = useMemo\([\s\S]*?\);/);
  assert.ok(intel, 'could not find the intel filter');
  assert.match(intel[0], /doc_type/, 'the company page must exclude documents');
  assert.doesNotMatch(intel[0], /"signal_extraction"/,
    'the company page must not hide plugin-written or health-read facts');
});

test('every capped list on the company page reports its full size', () => {
  // A list sliced to N with a heading that says nothing reads as "there are N". That is the same
  // failure as the get_account 15-fact cap, on a different surface, and it is what made an account
  // with 24 facts look like an account with 6.
  assert.match(COMPANY_VIEW, /const moreThan = /, 'the helper must exist');
  for (const [name, all] of [['What we know', 'allKnown'], ['What they want', 'allGoals'], ['Key concerns', 'allConcerns']]) {
    const section = COMPANY_VIEW.match(new RegExp(`${name}\\{moreThan\\(\\w+\\.length, ${all}\\.length\\)\\}`));
    assert.ok(section, `"${name}" must report its total via moreThan(shown, ${all}.length)`);
  }
});

test('moreThan stays silent when nothing is hidden', () => {
  // Extracted verbatim so the assertion tests the shipped expression, not a copy of it.
  const src = COMPANY_VIEW.match(/const moreThan = \(shown: number, total: number\) =>([\s\S]*?);/);
  assert.ok(src, 'could not find moreThan');
  const moreThan = new Function('shown', 'total', `return ${src[1].trim()};`);
  assert.equal(moreThan(6, 24), ' 6 of 24');
  assert.equal(moreThan(6, 6), '', 'a whole list must not be annotated');
  assert.equal(moreThan(3, 2), '', 'never claim to show more than exists');
  assert.equal(moreThan(0, 0), '');
});
