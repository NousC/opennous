// Our own people stay out of the account's world (GET-761). The concept and pattern prompts used
// to carry one founder's name as a literal; they now name the workspace's members and company,
// read through loadOurSide, so every workspace gets the same protection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConceptExtractPrompt } from '../src/computeConcepts.mjs';
import { buildPatternLabelPrompt } from '../src/computePatterns.mjs';
import { ourSideNamesList } from '../src/signals/extractionText.mjs';

const OURS = { ownerName: null, teamNames: ['Theo Bramwell', 'Avery Castellan'], companyName: 'Fernpoint', offer: null };
const batch = [{ i: 0, cat: 'pain', content: 'Their CRM is a mess.' }];

test('the concept prompt names every member and the company as our side', () => {
  const p = buildConceptExtractPrompt(batch, OURS);
  assert.match(p, /Never extract OUR own side \(the user, "Theo Bramwell", "Avery Castellan", "Fernpoint", "Nous"\)/);
  assert.match(p, /these people are our side; never extract them/);
});

test('the pattern prompt treats a cluster about our own people as noise', () => {
  const p = buildPatternLabelPrompt([{ id: 0, n: 2, claims: [] }], OURS);
  assert.match(p, /about the user or our own people \("Theo Bramwell", "Avery Castellan", "Fernpoint"\) not the account/);
});

test('nothing known about our side: the prompts still read, without an empty list', () => {
  assert.match(buildConceptExtractPrompt(batch, null), /\(the user, "Nous"\)/);
  assert.match(buildPatternLabelPrompt([], { teamNames: [] }), /our own people \(their own names\)/);
  assert.equal(ourSideNamesList({ teamNames: ['A B', 'A B'], companyName: 'A B' }), '"A B"');
});
