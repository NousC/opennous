// A Claude scheduled task as a webhook destination (GET-1035): the text a task is fired with, the
// fire itself, and which URLs the destination accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeFireText, CLAUDE_FIRE_TEXT_MAX, eventLabel } from '../dist/services/eventText.mjs';
import { deliverToSubscription, sendClaudeFire, CLAUDE_FIRE_URL_RE } from '../dist/db/webhookDeliveries.js';

const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_01AbC/fire';
const meeting = {
  id: 'evt-9', type: 'conversation.call_ended', occurred_at: '2026-10-26T15:00:00Z',
  account: { entity_id: 'acc-1', name: 'Atlas Freight' },
  data: { meeting_id: 'm1', title: 'Atlas weekly', call_type: 'onboarding', summary: 'Walked through the rollout.' },
};

test('the fire text says what happened, where, how to read the record, then the event', () => {
  const t = claudeFireText('conversation.call_ended', meeting);
  assert.match(t, /^OpenNous event: Meeting ended · Atlas Freight \(conversation\.call_ended\)\n/);
  assert.match(t, /When: 2026-10-26T15:00:00Z/);
  assert.match(t, /OpenNous MCP get_account with id "acc-1", or GET https:\/\/api\.opennous\.cloud\/v2\/accounts\/acc-1/);
  assert.match(t, /The event as JSON:\n\{/);
  assert.ok(t.includes('"summary": "Walked through the rollout."'));
});

test('the fire text tells the task to read get_context for the account first, for what the workspace has learned (GET-1042)', () => {
  const t = claudeFireText('conversation.call_ended', meeting);
  assert.match(t, /Before you act: OpenNous MCP get_context with focus "acc-1"[^\n]*what this workspace has learned/);
  assert.ok(t.indexOf('get_context') < t.indexOf('The event as JSON:'));
  const noAccount = claudeFireText('deal.stalled', { ...meeting, account: null });
  assert.ok(!noAccount.includes('get_context'), 'no account, no line');
});

test('the names are the new ones', () => {
  assert.equal(eventLabel('conversation.call_ended'), 'Meeting ended');
  assert.equal(eventLabel('deal.stalled'), 'Stale deal detected');
});

test('an event over the limit drops its evidence first, and never passes the limit', () => {
  const big = { ...meeting, evidence: { claims: ['x'.repeat(70_000)] } };
  const t = claudeFireText('conversation.call_ended', big);
  assert.ok(t.length <= CLAUDE_FIRE_TEXT_MAX);
  assert.ok(t.includes('"evidence_omitted": true'));
});

test('only a task Fire URL is accepted', () => {
  assert.ok(CLAUDE_FIRE_URL_RE.test(FIRE));
  assert.ok(!CLAUDE_FIRE_URL_RE.test('https://api.anthropic.com/v1/messages'));
  assert.ok(!CLAUDE_FIRE_URL_RE.test('https://evil.example/v1/claude_code/routines/trig_1/fire'));
});

test('the fire sends the token and the text; a revoked token is permanent, the rate limit is retried', async () => {
  let sent = null;
  const ok = await sendClaudeFire({ url: FIRE, token: 'sk-ant-oat01-x', eventType: 'deal.stalled', payload: meeting,
    fetchImpl: async (url, init) => { sent = { url, init }; return new Response('{"type":"routine_fire"}', { status: 200 }); } });
  assert.equal(ok.ok, true);
  assert.equal(sent.url, FIRE);
  assert.equal(sent.init.headers.Authorization, 'Bearer sk-ant-oat01-x');
  assert.equal(sent.init.headers['anthropic-version'], '2023-06-01');
  assert.match(JSON.parse(sent.init.body).text, /^OpenNous event: Stale deal detected · Atlas Freight/);
  const gone = await sendClaudeFire({ url: FIRE, token: 't', eventType: 'deal.won', payload: {}, fetchImpl: async () => new Response('', { status: 401 }) });
  assert.equal(gone.permanent, true);
  const busy = await sendClaudeFire({ url: FIRE, token: 't', eventType: 'deal.won', payload: {}, fetchImpl: async () => new Response('', { status: 429 }) });
  assert.equal(busy.permanent, false);
});

test('a Claude subscription decrypts its token, and never sends ciphertext', async () => {
  let auth = null;
  const sub = { url: FIRE, signing_secret: 's', destination_type: 'claude', github_token_enc: 'enc:abc' };
  const ok = await deliverToSubscription(sub, { eventType: 'deal.won', eventId: 'e', payload: {}, decryptToken: (e) => e.replace('enc:', 'tok-'),
    fetchImpl: async (_u, init) => { auth = init.headers.Authorization; return new Response('', { status: 200 }); } });
  assert.equal(ok.ok, true);
  assert.equal(auth, 'Bearer tok-abc');
  const bad = await deliverToSubscription(sub, { eventType: 'deal.won', eventId: 'e', payload: {}, decryptToken: (e) => e,
    fetchImpl: async () => { throw new Error('should not send'); } });
  assert.equal(bad.ok, false);
  assert.equal(bad.permanent, true);
});

// GET-1035: an event says where it came from, so an agent can open the transcript or thread itself.
test('an event names its source tool, that tool\'s own id and how to read it', async () => {
  const { eventSource } = await import('../dist/services/eventText.mjs');
  const { eventEnvelope } = await import('../dist/services/events.mjs');
  assert.deepEqual(eventSource({ source_ref: 'source://granola/not_8x2', url: 'https://notes.granola.ai/d/8x2' }),
    { tool: 'granola', name: 'Granola', id: 'not_8x2', url: 'https://notes.granola.ai/d/8x2', how: 'Granola MCP: get_meeting_transcript (or get_meetings) with this meeting id' });
  assert.equal(eventSource({ source_ref: 'source://acme/1' }).name, 'Acme');
  assert.equal(eventSource({}), null);
  const env = eventEnvelope({ type: 'conversation.call_ended', workspaceId: 'ws', occurredAt: 'now', record: {}, data: { source_ref: 'source://fireflies/01KX' } });
  assert.equal(env.source.name, 'Fireflies'); assert.equal(env.source.id, '01KX');
  assert.equal('source' in eventEnvelope({ type: 'deal.won', workspaceId: 'ws', occurredAt: 'now', record: {}, data: {} }), false);
});

test('the fire text says where to read the meeting and who was on it', () => {
  const t = claudeFireText('conversation.call_ended', {
    ...meeting, source: { tool: 'granola', name: 'Granola', id: 'not_8x2', url: null, how: 'Granola MCP: get_meeting_transcript (or get_meetings) with this meeting id' },
    data: { ...meeting.data, attendees: [{ name: 'Ines Okafor', email: 'ines@atlas.example' }] },
  });
  assert.match(t, /Source: Granola not_8x2\. To read it: Granola MCP: get_meeting_transcript/);
  assert.match(t, /Attendees: Ines Okafor <ines@atlas\.example>/);
});
