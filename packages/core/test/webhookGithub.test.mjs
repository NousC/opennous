// A GitHub repo as a webhook destination (GET-670): the dispatch we send, the small payload the
// workflow reads, which failures retry, and that a token never leaks or goes out as ciphertext.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/webhookGithub.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  githubEventType, githubClientPayload, sendGithubDispatch, deliverToSubscription,
} from '../dist/db/webhookDeliveries.js';
import { createTrigger, updateTrigger, TRIGGER_SUB_COLUMNS } from '../dist/db/triggers.js';

const fakeFetch = (status, { headers = {}, onCall } = {}) => async (url, init) => {
  onCall?.(url, init);
  return { status, statusText: '', headers: { get: (k) => headers[k.toLowerCase()] ?? null }, body: { cancel: async () => {} }, type: 'basic' };
};

test('event type is nous.<event>', () => {
  assert.equal(githubEventType('conversation.call_ended'), 'nous.conversation.call_ended');
  assert.equal(githubEventType('webhook.test'), 'nous.webhook.test');
});

test('client_payload from a record event: the person the event is about, the account, the meeting', () => {
  const p = githubClientPayload('conversation.call_ended', {
    id: 'evt_1', type: 'conversation.call_ended', occurred_at: '2026-10-04T10:00:00Z', workspace_id: 'ws',
    account: { entity_id: 'acc_1', name: 'Acme' },
    people: [{ entity_id: 'per_1', name: 'Jane' }, { entity_id: 'per_2' }],
    deal: { id: 'd' },
    data: { meeting_id: 'm_9', source: 'fireflies', title: 'Discovery' },
  });
  assert.deepEqual(p, {
    event_id: 'evt_1', event_type: 'conversation.call_ended', occurred_at: '2026-10-04T10:00:00Z', workspace_id: 'ws',
    entity_id: 'per_1', account_id: 'acc_1', meeting_id: 'm_9', source: 'fireflies',
    person_ids: null, count: null,
  });
  assert.ok(Object.keys(p).length <= 10, 'GitHub caps client_payload at ten top-level keys');
});

test('client_payload from an interaction event', () => {
  const p = githubClientPayload('interaction.meeting_held', {
    event_id: 'e2', event_type: 'interaction.meeting_held', occurred_at: 't', workspace_id: 'ws', entity_id: 'per_7',
    person: { entity_id: 'per_7' }, event_data: { source: 'fathom' },
  });
  assert.equal(p.entity_id, 'per_7');
  assert.equal(p.event_id, 'e2');
  assert.equal(p.source, 'fathom');
  assert.equal(p.account_id, null);
});

test('the dispatch: repo URL, bearer token, event_type and small payload', async () => {
  let seen;
  const r = await sendGithubDispatch({
    repo: 'acme/gtm', token: 'github_pat_x', eventType: 'conversation.reply_received',
    payload: { id: 'e', workspace_id: 'ws', people: [{ entity_id: 'p' }] },
    fetchImpl: fakeFetch(204, { onCall: (url, init) => { seen = { url, init }; } }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.status_code, 204);
  assert.equal(seen.url, 'https://api.github.com/repos/acme/gtm/dispatches');
  assert.equal(seen.init.headers.Authorization, 'Bearer github_pat_x');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.event_type, 'nous.conversation.reply_received');
  assert.equal(body.client_payload.entity_id, 'p');
});

test('a bad token or missing repo is permanent; a rate limit or 5xx retries', async () => {
  const send = (status, headers) => sendGithubDispatch({ repo: 'a/b', token: 't', eventType: 'x', payload: {}, fetchImpl: fakeFetch(status, { headers }) });
  const r401 = await send(401);
  assert.equal(r401.permanent, true);
  assert.match(r401.error, /token rejected/);
  assert.equal((await send(404)).permanent, true);
  assert.equal((await send(403)).permanent, true);
  assert.equal((await send(403, { 'x-ratelimit-remaining': '0' })).permanent, false);
  assert.equal((await send(429)).permanent, false);
  assert.equal((await send(502)).permanent, false);
});

test('deliverToSubscription routes by destination', async () => {
  let hit;
  const fetchImpl = fakeFetch(204, { onCall: (url) => { hit = url; } });
  const gh = { url: null, signing_secret: 's', destination_type: 'github', github_repo: 'acme/gtm', github_token_enc: 'ENC' };
  const r = await deliverToSubscription(gh, { eventType: 'deal.won', eventId: 'e', payload: {}, decryptToken: (x) => (x === 'ENC' ? 'plain' : null), fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(hit, 'https://api.github.com/repos/acme/gtm/dispatches');

  const url = { url: 'https://hooks.example.com/x', signing_secret: 's', destination_type: 'url' };
  await deliverToSubscription(url, { eventType: 'deal.won', eventId: 'e', payload: {}, fetchImpl: fakeFetch(200, { onCall: (u) => { hit = u; } }) });
  assert.equal(hit, 'https://hooks.example.com/x');
});

test('never sends ciphertext or nothing as a token', async () => {
  let called = false;
  const fetchImpl = fakeFetch(204, { onCall: () => { called = true; } });
  const gh = { url: null, signing_secret: 's', destination_type: 'github', github_repo: 'acme/gtm', github_token_enc: 'ENC' };
  // Both real decrypts return their input when they cannot read it.
  const r1 = await deliverToSubscription(gh, { eventType: 'x', eventId: 'e', payload: {}, decryptToken: (x) => x, fetchImpl });
  const r2 = await deliverToSubscription(gh, { eventType: 'x', eventId: 'e', payload: {}, fetchImpl });
  const r3 = await deliverToSubscription(gh, { eventType: 'x', eventId: 'e', payload: {}, decryptToken: () => { throw new Error('bad key'); }, fetchImpl });
  for (const r of [r1, r2, r3]) { assert.equal(r.ok, false); assert.equal(r.permanent, true); }
  assert.equal(called, false);
});

// ── create / update ──────────────────────────────────────────────────────────

function captureSupabase() {
  const writes = [];
  const q = {
    insert(row) { writes.push({ op: 'insert', row }); return q; },
    update(row) { writes.push({ op: 'update', row }); return q; },
    select() { return q; }, eq() { return q; },
    single() { return Promise.resolve({ data: { id: 'sub_1', ...writes.at(-1).row }, error: null }); },
    maybeSingle() { return Promise.resolve({ data: { id: 'sub_1', ...writes.at(-1).row }, error: null }); },
  };
  return { writes, from: () => q };
}

test('create a GitHub webhook: repo normalised, encrypted token stored, no url', async () => {
  const sb = captureSupabase();
  await createTrigger(sb, 'ws', {
    name: 'scorer', events: ['conversation.call_ended'],
    destination: { type: 'github', repo: 'https://github.com/acme/gtm.git', tokenEnc: 'ENC' },
  });
  const row = sb.writes[0].row;
  assert.equal(row.destination_type, 'github');
  assert.equal(row.github_repo, 'acme/gtm');
  assert.equal(row.github_token_enc, 'ENC');
  assert.equal(row.url, null);
});

test('a URL webhook still works the old way', async () => {
  const sb = captureSupabase();
  await createTrigger(sb, 'ws', { name: 'n8n', url: 'https://n8n.example.com/h', events: ['deal.won'] });
  assert.equal(sb.writes[0].row.destination_type, 'url');
  assert.equal(sb.writes[0].row.url, 'https://n8n.example.com/h');
});

test('bad GitHub destinations are refused with a code', async () => {
  const sb = captureSupabase();
  const make = (destination) => createTrigger(sb, 'ws', { name: 'x', events: ['deal.won'], destination });
  await assert.rejects(make({ type: 'github', repo: 'not a repo', tokenEnc: 'E' }), /invalid_github_repo/);
  await assert.rejects(make({ type: 'github', repo: 'a/b', tokenEnc: '' }), /github_token_required/);
  await assert.rejects(createTrigger(sb, 'ws', { name: 'x', events: ['deal.won'] }), /destination_required/);
});

test('switching a webhook to a URL clears the GitHub token', async () => {
  const sb = captureSupabase();
  await updateTrigger(sb, 'ws', 'sub_1', { destination: { type: 'url', url: 'https://x.example.com/h' } });
  const row = sb.writes[0].row;
  assert.equal(row.github_token_enc, null);
  assert.equal(row.github_repo, null);
  assert.equal(row.destination_type, 'url');
});

test('the token is never part of what a read selects', () => {
  assert.ok(!TRIGGER_SUB_COLUMNS.includes('github_token_enc'));
  assert.ok(TRIGGER_SUB_COLUMNS.includes('github_repo'));
});
