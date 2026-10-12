// 1.2 — the widened outcome vocabulary, so the loop learns from failure, not just from
// wins. These lock: (a) a reply's disposition decides win vs failure — an unsubscribe is
// NOT a conversion; (b) only positive outcomes (meeting, replied) count as wins, and
// bounced/opted_out/objection/no_response count as losses in the denominator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReplyOutcome } from '../src/intelligence/decisionTraces.mjs';
import { summarizeEffectiveness } from '../src/intelligence/jobs/recEffectiveness.mjs';

test('classifyReplyOutcome maps dispositions to outcomes', () => {
  assert.equal(classifyReplyOutcome('unsubscribe'), 'opted_out');
  assert.equal(classifyReplyOutcome('do_not_contact'), 'opted_out');
  assert.equal(classifyReplyOutcome('negative'), 'objection');
  assert.equal(classifyReplyOutcome('objection'), 'objection');
  assert.equal(classifyReplyOutcome('positive'), 'replied');
  assert.equal(classifyReplyOutcome('neutral'), 'replied');
  assert.equal(classifyReplyOutcome(undefined), 'replied');   // an unclassified inbound reply is still engagement
});

test('classifyReplyOutcome ignores non-human replies (keeps the trace open)', () => {
  assert.equal(classifyReplyOutcome('out_of_office'), null);
  assert.equal(classifyReplyOutcome('auto_reply'), null);
});

const catById = new Map([
  ['r1', 'leakage'], ['r2', 'leakage'],
  ['r3', 'signals'], ['r4', 'signals'], ['r5', 'signals'],
]);
const decided = [
  { rec_id: 'r1', action_property: 'interaction.email_sent', outcome: 'meeting' },              // win
  { rec_id: 'r2', action_property: 'interaction.email_sent', outcome: 'opted_out' },            // loss (used to score as a reply-win)
  { rec_id: 'r3', action_property: 'interaction.linkedin_message_sent', outcome: 'replied' },   // win
  { rec_id: 'r4', action_property: 'interaction.email_sent', outcome: 'no_response' },          // loss
  { rec_id: 'r5', action_property: 'interaction.email_sent', outcome: 'bounced' },              // loss
];

test('summarizeEffectiveness counts only positive outcomes as wins', () => {
  const o = summarizeEffectiveness(decided, catById);
  assert.equal(o.evidence.total, 5);
  assert.equal(o.evidence.converted, 2);          // meeting + replied only
  assert.equal(o.evidence.overall_rate, 0.4);
});

test('an unsubscribe reply is a loss, not a conversion (the bug this fixes)', () => {
  const o = summarizeEffectiveness(decided, catById);
  const leakage = o.evidence.by_category.find((c) => c.key === 'leakage');
  assert.equal(leakage.acted, 2);                 // meeting + opted_out
  assert.equal(leakage.converted, 1);             // ONLY the meeting — not the opt-out
  assert.equal(leakage.rate, 0.5);
});

test('failures counted in the denominator (no_response, bounced) sink the channel rate', () => {
  const o = summarizeEffectiveness(decided, catById);
  const email = o.evidence.by_channel.find((c) => c.key === 'email');
  const linkedin = o.evidence.by_channel.find((c) => c.key === 'linkedin');
  assert.equal(email.acted, 4);                   // r1,r2,r4,r5
  assert.equal(email.converted, 1);               // only the meeting
  assert.equal(email.rate, 0.25);
  assert.equal(linkedin.rate, 1);                 // r3 replied
});

test('by_outcome breakdown records every resolved label for the summary', () => {
  const o = summarizeEffectiveness(decided, catById);
  const counts = Object.fromEntries(o.evidence.by_outcome.map((r) => [r.key, r.count]));
  assert.deepEqual(counts, { meeting: 1, opted_out: 1, replied: 1, no_response: 1, bounced: 1 });
});
