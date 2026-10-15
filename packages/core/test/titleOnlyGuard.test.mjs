// A job title on its own is not a fact (GET-421). Cases are invented, in the shapes of real claims from the Harborline corpus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTitleOnlyFact } from '../dist/text/titleOnlyGuard.js';

const DROP = [
  'Osgood Penhallow is the General Sales Manager at Quarrymead AB.',
  'Bertil Saxby is the Finance Director at Northvale AG.',
  'Marguerite Thorne is the Executive Assistant - National Operations at Ferncastle Health.',
  'Hélène Brissot is a marketing consultant at Leadcraft Studio.',
  'Ysolde Kemp is a Marketing Manager.',
  'Prudence Arkwright is Founder and President of Bramble and Birch Outfitters.',
  'Caspian Hollins is the Business Manager at Meadowlark Data Centre.',
  'Alaric Penney is a Sales Consultant and Account Manager at Tamworthy Software.',
];
const KEEP = [
  // Claims of the kind the first (verb-allowlist) version wrongly dropped — validated against the full set.
  'Ewan Pryce recently joined Holloway Analytics as a sales manager, working alongside Wren and Bo.',
  'Billing confusion with invoices; accounting clerk questioned what credit was applied to an invoice.',
  'Lorcan notes that when a lead calls on a Saturday and the assigned person is not working, it goes to a general inbox.',
  'They are looking for more impactful lead generation beyond SMS, which the campaign links can support.',
  'Leads from the Twin Elm GM and the Stony Brook GM are being routed to the wrong inbox.',
  'Thornbury Outdoor & Garden is partly owned (25%) by the owner of Thornbury Hardware.',
  'The customer is switching CRM vendors, which requires lead feed migration.',
  'Delphine is an active user of the Harborline portal and can open individual lead profiles in it.',
  // a title PLUS something they said or do
  "Bastien Corrow's role is partially finance, partially sales manager, making him the person who controls lead management.",
  'Ambrose Tull is the person the Ravelstoke team typically brings their questions to.',
  'Hamish Doran is the Operations Manager at Pelling Marine and said June, July and August are their peak months.',
  'Clio Marchetti is taking care of the onboarding for Quillmere Data Centre.',
  // not a role at all
  'Prudence Arkwright is Portuguese and works on Lisbon time.',
  'The company is a regional reseller in Thornhaven.',
  // evidence: carries a quote
  'Ivo Tremaine says he likes the photo upload feature — "I like the photo upload".',
  // behaviour by a manager
  'Rupert Vane, Director of Financial Services, approved the rollout to the whole group.',
];

test('a bare role statement is dropped — the title is already filed as job_title', () => {
  for (const s of DROP) assert.equal(isTitleOnlyFact(s), true, s);
});

test('a title plus something said or done stays, and so does anything that is not a role', () => {
  for (const s of KEEP) assert.equal(isTitleOnlyFact(s), false, s);
});

test('empty, absurdly long, and non-string inputs are never dropped', () => {
  assert.equal(isTitleOnlyFact(''), false);
  assert.equal(isTitleOnlyFact(null), false);
  assert.equal(isTitleOnlyFact(undefined), false);
  assert.equal(isTitleOnlyFact('x'.repeat(400)), false);
});

test('a second clause hiding in the company slot keeps the fact (the Velmont case)', () => {
  assert.equal(isTitleOnlyFact('Cyril is the owner and president of Velmont and is the decision maker in the office.'), false);
  assert.equal(isTitleOnlyFact('Edmund Fairlie said Kit and Bo are both account managers at Larkfield Software.'), false);
  // …while the plain shapes with a real company name still go
  assert.equal(isTitleOnlyFact('Tobias Renner is the General Sales Manager at Lattice of Ashdown.'), true);
  assert.equal(isTitleOnlyFact('Lucan Ferrers is the General Manager at Ferncastle Health in Marlowfield.'), true);
});

test('a title carrying a change or a relation is kept — job_title cannot hold either', () => {
  for (const s of [
    'Piran is a new salesperson at the office.',
    'Dorian Pask is now the operations manager running the whole building at Hallowmere Systems.',
    'Petra Holloway is a former finance manager.',
    "Isolde is Barnabas Quint's sales manager.",
  ]) assert.equal(isTitleOnlyFact(s), false, s);
});
