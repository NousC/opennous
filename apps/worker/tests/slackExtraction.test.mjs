import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalEvidence } from '../src/noema/externalEvidence.mjs';
import { prepareSlackConversation, extractSlackConversation } from '../src/signals/slack.mjs';

const source = { workspace_id: 'workspace', slack_team_id: 'T1', slack_channel_id: 'C1' };
const authors = new Map([
  ['U1', { name: 'Morgan', side: 'internal' }],
  ['U2', { name: 'Dana', side: 'external', contactId: 'person-2' }],
  ['U3', { name: 'Alex', side: 'external', contactId: 'person-3' }],
]);
const message = (id, user, body, extra = {}) => ({ id, author_id: user, body, deleted: false,
  slack_ts: `170000000${id}.000001`, event_version: `170000000${id}.000001`,
  occurred_at: '2026-10-20T12:00:00Z', conversation_id: 'thread', ...extra });
const messages = [
  message('1', 'U1', 'I think their main issue is price. We should consider a discount and ask again next week.'),
  message('2', 'U2', 'Price is fine. We need SSO before security will approve our rollout. This blocks our launch.'),
  message('3', 'UNKNOWN', 'Our budget is one million dollars and we are ready to sign a contract immediately.'),
];

test('only a confirmed external author can support a finding', () => {
  const { evidence } = prepareSlackConversation({ source, messages, authors });
  const items = [
    { content: 'Price objection', speaker: 'Morgan', quote: 'I think their main issue is price.' },
    { content: 'SSO blocker', speaker: 'Dana', quote: 'We need SSO before security will approve our rollout.' },
    { content: 'Budget', quote: 'Our budget is one million dollars' },
    { content: 'Hallucination', speaker: 'Dana', quote: 'We are signing on Friday afternoon.' },
    { content: 'No evidence', speaker: 'Dana', quote: null },
  ];
  const accepted = externalEvidence(items, evidence);
  assert.deepEqual(accepted.map(i => i.content), ['SSO blocker']);
  assert.deepEqual(accepted[0].evidenceMessageIds, ['2']);
  assert.equal(accepted[0].speaker, 'Dana');
});

test('customer A cannot become the evidence for customer B', () => {
  const { evidence } = prepareSlackConversation({ source, messages, authors });
  assert.deepEqual(externalEvidence([{ quote: 'We need SSO before security will approve our rollout.' }], evidence,
    { contactId: 'person-3' }), []);
});

test('missing speaker is resolved only when the evidence identifies one person', () => {
  const { evidence } = prepareSlackConversation({ source, messages, authors });
  const item = { quote: 'We need SSO before security will approve our rollout.' };
  assert.equal(externalEvidence([item], evidence)[0].speaker, 'Dana');
  const ambiguous = [...evidence, { ...evidence[1], id: '4', authorId: 'U3', speaker: 'Alex', contactId: 'person-3' }];
  assert.deepEqual(externalEvidence([item], ambiguous), []);
});

test('evidence cannot impersonate another speaker', () => {
  const { evidence } = prepareSlackConversation({ source, messages, authors });
  assert.deepEqual(externalEvidence([{ quote: evidence[1].text, speaker: 'Morgan' }], evidence), []);
});

test('deletions, edits and changed author mappings change the version; retries do not', () => {
  const prepare = (ms = messages, as = authors) => prepareSlackConversation({ source, messages: ms, authors: as });
  assert.equal(prepare().fingerprint, prepare().fingerprint);
  assert.notEqual(prepare().fingerprint, prepare(messages.map(m => m.id === '2' ? { ...m, deleted: true, body: '' } : m)).fingerprint);
  assert.notEqual(prepare().fingerprint, prepare(messages.map(m => m.id === '2' ? { ...m, body: 'The issue is now resolved.' } : m)).fingerprint);
  assert.notEqual(prepare().fingerprint, prepare(messages, new Map([...authors].filter(([id]) => id !== 'U2'))).fingerprint);
  assert.equal(prepare().fingerprint, prepare(messages, new Map([...authors, ['U99', { side: 'external', contactId: 'unrelated', name: 'Someone else' }]])).fingerprint);
});

test('unknown authors and deleted messages are absent from model context', () => {
  const prepared = prepareSlackConversation({ source, messages: [...messages, message('4', 'U2', 'Deleted secret', { deleted: true })], authors });
  assert.doesNotMatch(prepared.transcript, /one million|Deleted secret/);
  assert.match(prepared.transcript, /Morgan:/);
  assert.match(prepared.transcript, /Dana:/);
});

test('Slack calls the same signal and insight readers with checked-author evidence', async () => {
  const calls = [];
  const out = await extractSlackConversation({ supabase: {}, source, messages, authors }, {
    activity: async (_db, p) => { calls.push(['activity', p]); return { id: 'observation-2' }; },
    observation: async (_db, p) => { calls.push([p.property === 'noema.read' ? 'read' : 'snapshot', p]); return { id: 'snapshot' }; },
    signals: async p => { calls.push(['signals', p]); return [{ content: 'SSO blocker' }]; },
    insights: async p => { calls.push(['insights', p]); p.onResult({ ok: true }); return 1; },
    actionItems: async p => { calls.push(['tasks', p]); return [{ property: 'action_item.slack_x_0' }]; },
  });
  assert.deepEqual(calls.map(([name]) => name), ['activity', 'snapshot', 'signals', 'insights', 'tasks', 'read']);
  // The snapshot is provenance, never an interaction a timeline or engagement reader counts.
  assert.equal(calls.find(([n]) => n === 'snapshot')[1].property, 'evidence.slack_conversation');
  const tasks = calls.find(([n]) => n === 'tasks')[1];
  assert.equal(tasks.messages, calls.find(([n]) => n === 'signals')[1].evidenceMessages);
  assert.deepEqual(tasks.people.map(p => [p.name, p.side]), [['Morgan', 'internal'], ['Dana', 'external'], ['Alex', 'external']]);
  assert.equal(tasks.sourceRef, calls.find(([n]) => n === 'signals')[1].sourceRef);
  // One conversation, one read receipt, one credit: the task read rides on it.
  assert.equal(calls.filter(([n]) => n === 'read').length, 1);
  assert.equal(calls.find(([n]) => n === 'read')[1].value.credits, 1);
  assert.equal(calls.find(([n]) => n === 'read')[1].value.tasks, 1);
  const signal = calls.find(([n]) => n === 'signals')[1];
  const insight = calls.find(([n]) => n === 'insights')[1];
  assert.equal(signal.strict, true);
  assert.equal(signal.contactId, 'person-2');
  assert.equal(signal.type, 'slack_message');
  assert.deepEqual(signal.sourceActivityIds, ['observation-2']);
  assert.equal(signal.evidenceMessages, insight.evidenceMessages);
  assert.equal(signal.evidenceMessages.find(m => m.id === '2').activityId, 'observation-2');
  assert.equal(signal.sourceRef, calls.find(([n]) => n === 'snapshot')[1].sourceRef);
  assert.deepEqual(insight.attendees, ['Dana']);
  assert.equal(insight.structuredOnly, true);
  assert.equal(out.facts.length, 1);
  assert.equal(out.insights, 1);
});

test('internal-only/unknown conversations do not call models or write activity', async () => {
  const fail = async () => { throw new Error('must not run'); };
  const out = await extractSlackConversation({ source, messages: messages.filter(m => m.author_id !== 'U2'), authors },
    { signals: fail, insights: fail, activity: fail, observation: fail });
  assert.equal(out.skipped, 'no_confirmed_external_author');
});

test('an insight model failure is retriable instead of marking a thread done', async () => {
  await assert.rejects(extractSlackConversation({ supabase: {}, source, messages, authors }, {
    activity: async () => ({ id: 'activity' }), observation: async () => ({ id: 'snapshot' }), signals: async () => [],
    insights: async p => { p.onResult({ ok: false, reason: 'unavailable' }); return 0; },
  }), /slack_insights_unavailable/);
});

test('an activity already inserted before a failed run is recovered on retry', async () => {
  let recovered = false;
  await extractSlackConversation({ supabase: {}, source, messages, authors, insightsEnabled: false }, {
    activity: async () => null,
    existingActivity: async () => { recovered = true; return { id: 'existing' }; },
    refreshActivity: async () => {},
    observation: async () => null,
    signals: async p => { assert.equal(p.activityId, 'existing'); return []; },
  });
  assert.equal(recovered, true);
});

test('a new reply does not duplicate previous messages on the account timeline', async () => {
  const stored = new Map();
  let refreshes = 0;
  const dependencies = {
    activity: async (_db, p) => {
      if (stored.has(p.externalId)) return null;
      const row = { id: `activity-${stored.size}` };
      stored.set(p.externalId, row);
      return row;
    },
    existingActivity: async (_db, _workspace, _source, id) => stored.get(id),
    refreshActivity: async () => { refreshes++; },
    observation: async () => null,
    signals: async () => [],
  };
  await extractSlackConversation({ supabase: {}, source, messages, authors, insightsEnabled: false }, dependencies);
  await extractSlackConversation({ supabase: {}, source,
    messages: [...messages, message('4', 'U2', 'Security will review this again next Tuesday.')], authors, insightsEnabled: false }, dependencies);
  assert.equal(stored.size, 2);
  assert.equal(refreshes, 1);
});

test('a moved root reconciles an empty former conversation with a stable source', () => {
  const prepared = prepareSlackConversation({ source, messages: [], authors, conversationId: 'hour-1' });
  assert.equal(prepared.sourceBase, 'source://slack/T1/C1/hour-1');
  assert.equal(prepared.external.length, 0);
});

test('activity mention labels preserve original Slack evidence and link only resolved people', async () => {
  let saved;
  const tagged = [message('mention-message', 'U2', 'Please invite <@U4>.')];
  const withMention = new Map([...authors, ['U4', { side: 'external', name: 'Morgan', contactId: 'person-4' }]]);
  await extractSlackConversation({ supabase: {}, source, messages: tagged, authors: withMention, insightsEnabled: false }, {
    activity: async (_, p) => { saved = p; return { id: 'activity' }; }, observation: async () => null, signals: async () => [],
  });
  assert.equal(saved.rawData.text, 'Please invite <@U4>.');
  assert.deepEqual(saved.rawData.slack_mentions.U4, { name: 'Morgan', personId: 'person-4' });
});

test("a teammate's own DM is filed as theirs: private type, owned snapshot, no workspace insights, tasks still read (GET-985)", async () => {
  const calls = [];
  const dmSource = { ...source, slack_channel_id: 'D1', channel_visibility: 'dm', owner_user_id: 'member-1' };
  await extractSlackConversation({ supabase: {}, source: dmSource, messages, authors, owner: { userId: 'member-1' } }, {
    activity: async (_db, p) => { calls.push(['activity', p]); return { id: 'observation-2' }; },
    observation: async (_db, p) => { calls.push([p.property === 'noema.read' ? 'read' : 'snapshot', p]); return { id: 'snapshot' }; },
    signals: async p => { calls.push(['signals', p]); return []; },
    insights: async () => { throw new Error('a DM must never write workspace insights'); },
    actionItems: async p => { calls.push(['tasks', p]); return []; },
  });
  assert.deepEqual(calls.map(([name]) => name), ['activity', 'snapshot', 'signals', 'tasks', 'read']);
  const activity = calls.find(([n]) => n === 'activity')[1];
  assert.equal(activity.type, 'slack_dm');
  assert.equal(activity.ownerUserId, 'member-1');
  assert.deepEqual(activity.rawData.mailbox_owner_ids, ['member-1']);
  const snapshot = calls.find(([n]) => n === 'snapshot')[1];
  assert.equal(snapshot.property, 'evidence.slack_dm_conversation');
  assert.equal(snapshot.ownerUserId, 'member-1');
  assert.deepEqual(snapshot.raw.mailbox_owner_ids, ['member-1']);
  assert.equal(calls.find(([n]) => n === 'signals')[1].type, 'slack_dm');
  const read = calls.find(([n]) => n === 'read')[1];
  assert.equal(read.value.credits, 1, 'one credit per read, like a channel');
});
