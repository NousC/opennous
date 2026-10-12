// A customer call is read, not graded (GET-288). The output a CS team acts on is "the sponsor went
// quiet, adoption stalled in F&I, they asked about a second rooftop" — not 3.6/10.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/accountHealth.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHealthReadJson, healthPageSections, healthHeadline, buildHealthReadPrompt, healthStateFrom,
} from '../dist/services/accountHealth.js';
import { callPageTitle } from '../dist/services/callPage.js';

const FULL = JSON.stringify({
  summary: 'A quarterly check-in with Corvane Auto: Rupert from our side, Osric and his partner from theirs, covering usage since July and the F&I rollout.',
  what_changed: 'Corvane Auto moved deal-jacket sign-off into the F&I desk and stopped printing paper copies.',
  adoption: 'Two salespeople use the tablet check-in daily; the F&I manager has not logged in since July.',
  standing: 'at_risk',
  risks: [{ text: 'The sponsor who bought it has left the dealership.', quote: 'Yeah, Gideon moved on in June.' }],
  expansion: [{ text: 'They asked whether a second rooftop could be added.', quote: 'Could we run this at the Westgate store too?' }],
  commitments: [{ text: 'We send the F&I training link by Friday.', quote: "I'll get that over to you by Friday." }],
});

test('a full read keeps every part, with its evidence', () => {
  const h = parseHealthReadJson(FULL);
  assert.equal(h.standing, 'at_risk');
  assert.equal(h.risks[0].quote, 'Yeah, Gideon moved on in June.');
  assert.equal(h.expansion.length, 1);
  assert.equal(h.commitments[0].text, 'We send the F&I training link by Friday.');
});

test('a quiet account is a valid answer, not a failure', () => {
  const h = parseHealthReadJson(JSON.stringify({
    what_changed: 'Nothing material changed; they are using it the same way as last quarter.',
    adoption: 'Steady use by the two-person BDC.', standing: 'positive', risks: [], expansion: [], commitments: [],
  }));
  assert.equal(h.standing, 'positive');
  assert.deepEqual(h.risks, []);
  assert.equal(healthHeadline(h), 'Healthy');
});

test('an unreadable answer is null, so we never file an empty page that looks quiet', () => {
  assert.equal(parseHealthReadJson('the model apologised'), null);
  assert.equal(parseHealthReadJson(JSON.stringify({ what_changed: '', adoption: '', risks: [], expansion: [], commitments: [] })), null);
});

test('an invented standing falls back to neutral rather than alarming anyone', () => {
  const h = parseHealthReadJson(JSON.stringify({ what_changed: 'x', standing: 'on fire', risks: [], expansion: [], commitments: [] }));
  assert.equal(h.standing, 'neutral');
});

test('the headline says the standing and what drives it', () => {
  assert.equal(healthHeadline(parseHealthReadJson(FULL)), 'At risk · 1 risk · 1 expansion signal');
});

test('empty sections are left out, never padded', () => {
  const labels = healthPageSections(parseHealthReadJson(FULL)).map(s => s.label);
  assert.deepEqual(labels, ['Summary', 'What changed', 'Adoption', 'Risk', 'Expansion signal', 'Commitments']);
  const quiet = healthPageSections(parseHealthReadJson(JSON.stringify({
    what_changed: 'Nothing changed.', adoption: '', standing: 'neutral', risks: [], expansion: [], commitments: [],
  })));
  assert.deepEqual(quiet.map(s => s.label), ['What changed']);
});

test('a risk carries its quote underneath it', () => {
  const risk = healthPageSections(parseHealthReadJson(FULL)).find(s => s.label === 'Risk');
  assert.match(risk.body, /^- The sponsor who bought it has left/);
  assert.match(risk.body, /> Yeah, Gideon moved on in June\./);
});

test('the prompt refuses to grade the rep', () => {
  const p = buildHealthReadPrompt('Speaker: hello', { title: 'QBR', callType: 'business_review' });
  assert.match(p, /not a sales call and you are not grading the rep/i);
  assert.match(p, /how is this account doing/i);
  assert.ok(!/objection handling|next_step_secured/.test(p), 'no coaching dimensions leak in');
});

test('a CS call still gets a summary — the health read replaces the SCORE, not the summary', () => {
  const h = parseHealthReadJson(FULL);
  assert.match(h.summary, /quarterly check-in with Corvane Auto/);
  assert.equal(healthPageSections(h)[0].label, 'Summary');
});

test('the page names the kind of call, and keeps the meeting name and date', () => {
  assert.equal(callPageTitle('Corvane Auto - Harborline', '2025-09-17T17:00:00Z', 'business_review'),
    'Business review — Corvane Auto - Harborline — Sep 17, 2025');
  assert.equal(callPageTitle('Wexcombe Car Sales | Portal Training', '2025-09-18T15:00:00Z', 'training'),
    'Training — Wexcombe Car Sales | Portal Training — Sep 18, 2025');
  assert.equal(callPageTitle('Brackenfold Ford', '2026-09-16T14:50:00Z', 'demo'),
    'Demo — Brackenfold Ford — Sep 16, 2026');
  // An unknown or missing type keeps the name every page had before types existed.
  assert.equal(callPageTitle('Brackenfold Ford', '2026-09-16T14:50:00Z', null),
    'Call summary — Brackenfold Ford — Sep 16, 2026');
});

test('the account carries its standing, so "who is at risk" needs no transcript', () => {
  const state = healthStateFrom(parseHealthReadJson(FULL), { at: '2025-09-17T17:00:00Z', sourceRef: 'source://fellow/abc' });
  assert.equal(state.standing, 'at_risk');
  assert.deepEqual(state.risks, ['The sponsor who bought it has left the dealership.']);
  assert.deepEqual(state.expansion, ['They asked whether a second rooftop could be added.']);
  assert.equal(state.source_ref, 'source://fellow/abc');
});
