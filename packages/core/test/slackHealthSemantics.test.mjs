// One rule for what an activity row is, read the same by every health surface (GET-976).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTwoWayTouch, engagementWindows, decisionMakers, selectNextStep } from '../dist/services/accountHealthScore.mjs';
import { multiThread, isBuyerResponse, isEvidenceSnapshot, medianBuyerResponseDays } from '../dist/services/engagement.mjs';
import { computeDealHealth } from '../dist/services/dealHealth.mjs';
import { lastBuyerResponseAt, sliceDealHealth } from '../dist/services/dealHealthSlice.mjs';

const DAY = 86_400_000;
const now = Date.parse('2026-10-21T12:00:00Z');
const ago = (d) => new Date(now - d * DAY).toISOString();
const row = (contact_id, activity_type, d, extra = {}) => ({ id: `${contact_id}-${activity_type}-${d}`, contact_id, activity_type, occurred_at: ago(d), ...extra });

test('a Slack message they wrote is a two-way touch; ours only counts on a conversation; a snapshot never', () => {
  assert.equal(isTwoWayTouch('slack_message', { outbound: false }), true);
  assert.equal(isTwoWayTouch('slack_message', { outbound: true, conversational: false }), false);
  assert.equal(isTwoWayTouch('slack_conversation', { outbound: false }), false);
  assert.equal(isEvidenceSnapshot('interaction.slack_conversation'), true);
  const w = engagementWindows({ now, activity: [
    row('p1', 'slack_message', 1, { is_outbound: false }),
    row('p1', 'slack_message', 1, { raw_data: { is_outbound: false } }),
    row('p1', 'slack_conversation', 1),
  ] });
  assert.equal(w.recent, 2);
});

test('direction from the payload drives Last Response and the buyer response time', () => {
  const theirs = row('p1', 'slack_message', 3, { is_outbound: false });
  const ours = row('p1', 'slack_dm', 1, { raw_data: { is_outbound: true } });
  assert.equal(isBuyerResponse(theirs), true);
  assert.equal(isBuyerResponse(ours), false);
  assert.equal(isBuyerResponse(row('p1', 'slack_conversation', 0)), false);
  assert.equal(lastBuyerResponseAt([theirs, ours, row('p1', 'slack_conversation', 0)], now), theirs.occurred_at);
  assert.equal(medianBuyerResponseDays([row('p1', 'email_sent', 5), row('p1', 'slack_message', 3, { is_outbound: false })]), 2);
});

test('multi-threading counts people in conversation, apart from product users and people only identified', () => {
  const people = ['writer', 'admin', 'user', 'emailer', 'connected', 'titled'].map(id => ({ id, title: id === 'titled' ? 'Chief Executive Officer' : null, signal_count: 3, last_activity_at: ago(1) }));
  const activity = [
    row('writer', 'slack_message', 1, { is_outbound: false }),
    row('admin', 'slack_message', 2, { is_outbound: false }),
    row('user', 'product_used', 1),
    row('emailer', 'email_received', 33),
    row('connected', 'linkedin_connected', 10),
    row('writer', 'slack_conversation', 1),
  ];
  const mt = multiThread(people, now, activity);
  assert.equal(mt.engaged, 3);
  assert.equal(mt.product_users, 1);
  assert.equal(mt.identified, 2);
  assert.deepEqual(mt.engaged_ids, ['writer', 'admin', 'emailer']);
  // Old callers without activity keep the old reading.
  assert.equal(multiThread(people, now).engaged, 6);
});

test('an unnamed role reconciles to the one person whose title holds it, keeping the claim', () => {
  const claim = { id: 'claim-ceo', category: 'authority', created_at: ago(20), metadata: { role: 'decision_maker', person_name: null, person_title: 'CEO', engagement: 'not_engaged', quote: 'Our CEO signs off on tools like this' } };
  const people = [
    { id: 'founder', name: 'Avery Holt', title: 'Founder & CEO' },
    { id: 'cto', name: 'Sam Ortiz', title: 'CTO' },
    { id: 'dir', name: 'Kim Vale', title: 'Director of Operations' },
  ];
  const [d] = decisionMakers({ notes: [claim], stakeholders: people, activity: [row('founder', 'linkedin_connected', 50)], now });
  assert.equal(d.entity_id, 'founder');
  assert.equal(d.name, 'Avery Holt');
  assert.equal(d.unnamed, false);
  assert.deepEqual(d.evidence, ['claim-ceo']);
  assert.equal(d.matched_by, 'role_in_title');
  assert.equal(d.claim_title, 'CEO');
  // The title is identity, not engagement: a LinkedIn connect is not taking part.
  assert.equal(d.status, 'not_engaged');
  // Two holders of the role: nobody is guessed.
  const two = decisionMakers({ notes: [claim], stakeholders: [...people, { id: 'co', name: 'Lee Park', title: 'Co-CEO' }], now });
  assert.equal(two[0].unnamed, true);
  // A different role never matches.
  const cfo = decisionMakers({ notes: [{ ...claim, metadata: { ...claim.metadata, person_title: 'CFO' } }], stakeholders: people, now });
  assert.equal(cfo[0].unnamed, true);
});

test('a step someone asked for, and nobody agreed yet, is Requested, not Agreed', () => {
  const activity = [row('p1', 'slack_message', 1, { id: 'act-1', is_outbound: false })];
  const nextSteps = [{ entity_id: 'p1', title: 'Set up a walkthrough with the CRO', status: 'open', due_at: null, occurred_at: ago(1),
    commitment: 'requested', asked_by: 'Dana Whitfield', owner_name: 'Morgan Reyes', participants: [{ name: 'Priya Lund' }], source_id: 'act-1', quote: 'Please set up a call' }];
  const pick = selectNextStep({ activity, nextSteps, now });
  assert.equal(pick.status, 'requested');
  assert.equal(pick.asked_by, 'Dana Whitfield');
  assert.equal(pick.owner_name, 'Morgan Reyes');
  assert.equal(pick.conversation.kind, 'slack');
  assert.equal(pick.conversation.title, null);
  assert.equal(pick.due_at, null);
  assert.equal(selectNextStep({ activity, nextSteps: [{ ...nextSteps[0], commitment: 'accepted' }], now }).status, 'agreed');
});

test('deal health: Slack counts as a response, the snapshot never as activity, expansion is cited and the step is Requested', () => {
  const stakeholders = [{ id: 'p1', title: 'CTO' }, { id: 'p2', title: 'COO' }, { id: 'p3', title: 'CEO' }];
  const notes = [{ id: 'exp-1', source: 'signal_extraction', category: 'expansion_signal', created_at: ago(1), content: 'Wants the CRO onboarded' }];
  const activity = [row('p1', 'slack_message', 1, { is_outbound: false }), row('p1', 'slack_conversation', 1), row('p2', 'slack_message', 2, { is_outbound: false })];
  const nextSteps = [{ entity_id: 'p1', title: 'Set up a walkthrough', status: 'open', occurred_at: ago(1), commitment: 'requested', asked_by: 'Dana Whitfield' }];
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const dh = computeDealHealth({ company: { id: 'c' }, notes, activity, stakeholders, nextSteps });
    const sig = Object.fromEntries(dh.smart.map(s => [s.key, s]));
    const num = Object.fromEntries(dh.numeric.map(s => [s.key, s]));
    assert.equal(sig.next_step.level, 'Requested');
    assert.equal(sig.next_step.tone, 'warn');
    assert.match(sig.next_step.reason, /Dana Whitfield asked/);
    assert.equal(sig.buyer_urgency.level, 'High');
    assert.deepEqual(sig.buyer_urgency.evidence, ['exp-1']);
    assert.match(sig.buyer_urgency.reason, /expansion ask/);
    assert.equal(num.multi_threading.value, '2/3 in conversation');
    assert.deepEqual(num.multi_threading.detail, { in_conversation: 2, product_users: 0, identified: 1, total: 3 });
    assert.notEqual(num.last_response.value, '—');
  } finally { Date.now = realNow; }
  // The deal slice never counts a snapshot as a person's activity.
  const sliced = sliceDealHealth({ company: { id: 'c' }, contacts: stakeholders.map(s => ({ id: s.id, job_title: s.title })), notes: [], activity, nextSteps: [] }, { implied: true, status: 'open' });
  assert.equal(sliced.activity.length, 2);
});

test('Buying Committee counts the seniors in conversation, not every senior title on the account', () => {
  const recent = (d) => new Date(Date.now() - d * DAY).toISOString();
  const stakeholders = ['Founder & CEO', 'VP Sales', 'Director of Ops', 'Head of Growth', 'Analyst']
    .map((title, i) => ({ id: `s${i}`, title, signal_count: 2, last_activity_at: recent(1) }));
  const activity = [{ id: 'a1', contact_id: 's0', activity_type: 'slack_message', is_outbound: false, occurred_at: recent(1) }];
  const dh = computeDealHealth({ company: { id: 'c1', name: 'Harborline' }, notes: [], activity, stakeholders, nextSteps: [] });
  const committee = (dh.smart ?? dh.factors).find(f => f.key === 'decision_maker');
  assert.equal(committee.level, 'Strong');
  assert.match(committee.reason, /^1 senior stakeholder in conversation, of 5 on the account/);
});
