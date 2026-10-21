// A claim states the fact; who said it is stored beside it (GET-962).
//
// Nearly every claim opened with "Hollis Vane says Quillmere's …". The subject guard still checks the
// model's sentence names who the fact is about; after it passes, factWording takes the attribution off
// the front. A person fact keeps the person as its subject (the subject-name invariant reads it), a
// company fact loses the speaker and the company's own name. Run:
//   node --test apps/worker/tests/factWording.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factWording } from '../src/signals/extractionText.mjs';

const who = { subjectName: 'Hollis Vane', companyName: 'Quillmere' };
const co = (content) => factWording(content, { ...who, about: 'company' });
const person = (content) => factWording(content, { ...who, about: 'person' });

test('a company fact loses the speaker and the company name in front', () => {
  assert.equal(co("Hollis Vane says Quillmere's lead generation is not very strong."), 'Lead generation is not very strong.');
  assert.equal(co("Hollis Vane's company Quillmere's HubSpot upgrade fields are not reliable enough to act on."), 'HubSpot upgrade fields are not reliable enough to act on.');
  assert.equal(co("Hollis Vane's company (Quillmere) has changed its CS to track motions."), 'Has changed its CS to track motions.');
  assert.equal(co('Hollis Vane wants to prospect into churned customers.'), 'Wants to prospect into churned customers.');
  assert.equal(co('Hollis Vane said that Quillmere makes about 50,000 outbound calls a year.'), 'Quillmere makes about 50,000 outbound calls a year.');
  assert.equal(co('Hollis says his top priority is a handoff workflow.'), 'Top priority is a handoff workflow.');
});

test('a person fact keeps the person, without "says"', () => {
  assert.equal(person('Hollis Vane says he would not have more than two or three people using the tool.'), 'Hollis Vane would not have more than two or three people using the tool.');
  assert.equal(person('Hollis Vane said he is good with the pricing and would pay now.'), 'Hollis Vane is good with the pricing and would pay now.');
  // No pronoun to fold in: the sentence stays as written rather than losing its subject.
  assert.equal(person("Hollis Vane says Quillmere's data is now connected."), "Hollis Vane says Quillmere's data is now connected.");
  assert.equal(person('Hollis Vane found us through a Hacker News post.'), 'Hollis Vane found us through a Hacker News post.');
});

test('a fact that does not open with attribution is left alone', () => {
  assert.equal(co('Quillmere focuses on Canadian dealerships.'), 'Quillmere focuses on Canadian dealerships.');
  assert.equal(co('Sales team: three AEs and a CRO.'), 'Sales team: three AEs and a CRO.');
  // Another person opening a company fact is the fact's own subject, not attribution.
  assert.equal(co('Kelsey onboards every account.'), 'Kelsey onboards every account.');
  assert.equal(factWording('Hollis Vane says the CRM is bad.', { about: 'company' }), 'Hollis Vane says the CRM is bad.', 'no names known: unchanged');
});

test('a company fact keeps its person when taking them off would leave a fragment or a dangling "he"', () => {
  assert.equal(co('Hollis Vane is pushing an operations overhaul before agents.'), 'Hollis Vane is pushing an operations overhaul before agents.');
  assert.equal(co('Hollis Vane sees CS as the place for upgrades.'), 'Hollis Vane sees CS as the place for upgrades.');
  assert.equal(co('Hollis Vane says the outcome he wants from agents is booked demos.'), 'Hollis Vane says the outcome he wants from agents is booked demos.');
  assert.equal(co('Hollis Vane plans to bring in the CRO.'), 'Plans to bring in the CRO.');
});
