// Deal health reads the sales process (GET-691): the buying committee named on calls (champion,
// economic buyer, blocker, and who left), whether budget came up, and whether a next step is agreed
// and still in date. Each is graded from conversation facts, and silence is Unknown, never good.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/dealHealthCommittee.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDealHealth } from '../dist/services/dealHealth.mjs';
import { dealHealthReason } from '../dist/services/dealHealthSlice.mjs';

const DAY = 86_400_000;
const iso = (d) => new Date(Date.now() + d * DAY).toISOString();
let n = 0;
const note = (category, metadata = {}, extra = {}) => ({
  id: `n${++n}`, source: 'signal_extraction', category, metadata, content: `${category} fact`, created_at: iso(-3), ...extra,
});
const people = [{ id: 'p1', title: 'VP Sales', seniority: 'vp' }, { id: 'p2', title: 'Ops Manager' }];
const met = [{ activity_type: 'meeting', occurred_at: iso(-2), contact_id: 'p1' }];
const sig = (h, key) => h.smart.find(s => s.key === key);
const run = (notes, extra = {}) => computeDealHealth({ notes, activity: met, stakeholders: people, ...extra });

test('a champion and an economic buyer named on calls, both engaged, is a strong committee', () => {
  // Both have to be in the conversation (GET-800): engaged decision makers over known ones.
  const h = run([note('authority', { role: 'champion' }, { entity_id: 'p2' }), note('authority', { role: 'economic_buyer' }, { entity_id: 'p1' })],
    { activity: [...met, { activity_type: 'email_received', occurred_at: iso(-4), contact_id: 'p2' }] });
  const c = sig(h, 'decision_maker');
  assert.equal(c.label, 'Buying Committee');
  assert.equal(c.level, 'Strong');
  assert.equal(c.tone, 'good');
  assert.equal(c.evidence.length, 2);
});

test('the champion leaving is the headline risk', () => {
  const h = run([
    note('authority', { role: 'champion' }, { entity_id: 'p2' }),
    note('authority', { role: 'economic_buyer' }, { entity_id: 'p1' }),
    note('staff_change', { change: 'left' }, { entity_id: 'p2', content: 'Torvald left last month' }),
  ], { nextSteps: [] });
  const c = sig(h, 'decision_maker');
  assert.equal(c.level, 'Champion left');
  assert.equal(c.tone, 'bad');
  assert.match(c.reason, /Torvald left/);
  assert.match(dealHealthReason(h), /^The champion left/);
});

test('a blocker with nobody championing it is blocked', () => {
  const c = sig(run([note('authority', { role: 'blocker' }, { entity_id: 'p1' })]), 'decision_maker');
  assert.equal(c.level, 'Blocked');
  assert.equal(c.tone, 'bad');
});

test('no buying role named falls back to seniority, as before', () => {
  const c = sig(run([]), 'decision_maker');
  assert.ok(['Strong', 'Single-threaded', 'Moderate', 'Weak'].includes(c.level));
});

test('budget is unknown until it comes up, then shows what was said', () => {
  assert.equal(sig(run([]), 'budget').tone, 'unknown');
  const b = sig(run([note('budget', {}, { content: 'About $30k a year earmarked for data tooling' })]), 'budget');
  assert.equal(b.level, 'Discussed');
  assert.match(b.reason, /\$30k/);
});

test('next step: agreed, overdue, none — and left out when not loaded', () => {
  assert.equal(sig(run([]), 'next_step'), undefined);
  const agreed = sig(run([], { nextSteps: [{ title: 'Send the security questionnaire', status: 'open', due_at: iso(3) }] }), 'next_step');
  assert.equal(agreed.level, 'Agreed');
  assert.match(agreed.reason, /security questionnaire/);
  const late = sig(run([], { nextSteps: [{ title: 'Pricing call', status: 'open', due_at: iso(-20) }] }), 'next_step');
  assert.equal(late.level, 'Overdue');
  assert.equal(late.tone, 'bad');
  const none = sig(run([], { nextSteps: [] }), 'next_step');
  assert.equal(none.level, 'None');
  assert.equal(none.tone, 'bad');
});

test('no conversation at all leaves next step unknown, not none', () => {
  const h = computeDealHealth({ notes: [], activity: [], stakeholders: [], nextSteps: [] });
  assert.equal(sig(h, 'next_step').tone, 'unknown');
});

test('an agreed next step and a named committee lift the score over the same deal without them', () => {
  const bare = run([], { nextSteps: [] });
  const rich = run([note('authority', { role: 'champion' }, { entity_id: 'p2' }), note('authority', { role: 'economic_buyer' }, { entity_id: 'p1' }), note('budget')],
    { nextSteps: [{ title: 'Pilot kickoff', status: 'open', due_at: iso(5) }] });
  assert.ok(rich.score > bare.score, `${rich.score} > ${bare.score}`);
});
