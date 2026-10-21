// PostHog as a source (GET-751): the connect test refuses what cannot work before anything is
// saved, the catalogue entry agrees with the webhook registry, and the account page's usage card
// reads only what PostHog wrote.
//
// Run: node --test apps/api/tests/posthogProvider.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testPostHog } from '../src/providers/test.mjs';
import { CATALOGUE, assertCatalogueIsSane } from '../src/providers/catalogue.mjs';
import { WEBHOOK_HANDLERS } from '../src/providers/webhooks.mjs';
import { productUsageFromClaims, personProductUsage } from '../src/lib/productUsage.mjs';
import { isTouch } from '../src/lib/activityKinds.mjs';

const answer = (status, body) => async (url, init) => {
  answer.calls.push({ url, auth: init?.headers?.Authorization });
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};
answer.calls = [];

test('a key that reads the project connects, and names the project', async () => {
  answer.calls = [];
  const r = await testPostHog({ api_key: 'phx_live', project_id: '12345', host: 'eu' }, { fetchImpl: answer(200, { id: 12345, name: 'Harborline app' }) });
  assert.deepEqual(r, { verified: true, message: 'Connected to "Harborline app" on eu.posthog.com' });
  assert.deepEqual(answer.calls, [{ url: 'https://eu.posthog.com/api/projects/12345/', auth: 'Bearer phx_live' }]);
});

test('the project token, a missing project id or a private host are refused without a call', async () => {
  const never = async () => { throw new Error('must not call PostHog'); };
  assert.match((await testPostHog({ api_key: 'phc_token', project_id: '1' }, { fetchImpl: never })).message, /project token/);
  assert.match((await testPostHog({ api_key: 'phx_live', project_id: '' }, { fetchImpl: never })).message, /project ID/);
  assert.match((await testPostHog({ api_key: 'phx_live', project_id: '1', host: 'http://10.0.0.4' }, { fetchImpl: never })).message, /us or eu/);
  assert.equal((await testPostHog({ project_id: '1' }, { fetchImpl: never })).verified, false);
});

test('PostHog\'s refusals say which part is wrong', async () => {
  const creds = { api_key: 'phx_live', project_id: '7' };
  assert.match((await testPostHog(creds, { fetchImpl: answer(401, {}) })).message, /rejected this key/);
  assert.match((await testPostHog(creds, { fetchImpl: answer(403, {}) })).message, /Project read/);
  assert.match((await testPostHog(creds, { fetchImpl: answer(404, {}) })).message, /No project 7 on us\.posthog\.com/);
});

test('the catalogue entry is a five-field, auto-webhook analytics source with a registered handler', () => {
  const p = CATALOGUE.posthog;
  assert.equal(p.auth, 'credentials');
  assert.equal(p.webhook, 'auto');
  assert.equal(p.category, 'analytics');
  assert.deepEqual(p.authFields.map(f => f.name), ['api_key', 'project_id', 'host', 'signup_event', 'key_events']);
  assert.equal(typeof WEBHOOK_HANDLERS.posthog?.subscribe, 'function');
  assert.doesNotThrow(() => assertCatalogueIsSane());
});

test('the usage card is null for an account PostHog never wrote, even with CRM usage fields', () => {
  assert.equal(productUsageFromClaims([{ property: 'cs.active_users_30d', value: 4 }]), null);
  assert.equal(productUsageFromClaims([]), null);
});

test('the usage card reads PostHog\'s facts, wrapped or not', () => {
  const u = productUsageFromClaims([
    { property: 'cs.active_users_30d', value: { value: 3 }, computed_at: '2026-10-18T00:10:00Z' },
    { property: 'cs.total_users', value: 5, computed_at: '2026-10-18T00:10:00Z' },
    { property: 'cs.last_used_at', value: '2026-10-17T12:00:00.000Z', computed_at: '2026-10-18T00:12:00Z' },
    { property: 'product.active_users_prev_30d', value: 4, computed_at: '2026-10-18T00:10:00Z' },
    { property: 'product.key_events', value: { report_created: { count30d: 9, users30d: 2, firstSeen: '2026-08-25T10:00:00.000Z' } }, computed_at: '2026-10-18T00:10:00Z' },
  ]);
  assert.equal(u.active_users_30d, 3);
  assert.equal(u.total_users, 5);
  assert.equal(u.active_users_prev_30d, 4);
  assert.equal(u.active_users_7d, null);
  assert.equal(u.last_used_at, '2026-10-17T12:00:00.000Z');
  assert.deepEqual(u.key_events, [{ name: 'report_created', count_30d: 9, users_30d: 2, first_seen: '2026-08-25T10:00:00.000Z' }]);
  assert.equal(u.updated_at, '2026-10-18T00:12:00Z');
});

test('product use and signups are not sales touches', () => {
  assert.equal(isTouch({ property: 'interaction.product_used' }), false);
  assert.equal(isTouch({ property: 'interaction.signed_up' }), false);
  assert.equal(isTouch({ property: 'interaction.email_sent' }), true);
});

test('a person\'s usage: a user while product.user is true, null when PostHog has nothing', () => {
  assert.deepEqual(personProductUsage([
    { property: 'product.user', value: true }, { property: 'product.last_seen_at', value: '2026-10-19T08:00:00.000Z' },
    { property: 'product.active_days_30d', value: 2 }, { property: 'product.events_30d', value: { value: 40 } },
  ]), { user: true, last_seen_at: '2026-10-19T08:00:00.000Z', active_days_30d: 2, events_30d: 40 });
  assert.equal(personProductUsage([{ property: 'product.user', value: false }]).user, false);
  assert.equal(personProductUsage([]), null);
});

import { removeOurPostHogDestinations, updatePostHogEvents } from '../src/providers/webhooks.mjs';

test('a reconnect removes only our older destinations for this workspace', async () => {
  const calls = [];
  const request = async (_k, _b, path, opts = {}) => {
    calls.push([opts.method ?? 'GET', path]);
    if (!opts.method) return { results: [
      { id: 'old', inputs: { url: { value: 'https://api.example/inbound/posthog/ws1' } } },
      { id: 'new', inputs: { url: { value: 'https://api.example/inbound/posthog/ws1' } } },
      { id: 'theirs', inputs: { url: { value: 'https://hooks.elsewhere.example/x' } } },
      { id: 'gone', deleted: true, inputs: { url: { value: 'https://api.example/inbound/posthog/ws1' } } },
    ] };
    return {};
  };
  const n = await removeOurPostHogDestinations('phx', 'https://us.posthog.com', '42', 'https://api.example/inbound/posthog/ws1', { keepId: 'new', request });
  assert.equal(n, 1);
  assert.deepEqual(calls.filter(c => c[0] === 'PATCH'), [['PATCH', '/api/projects/42/hog_functions/old/']]);
});

test('events change in place: the destination\'s filter, and the settings in force', async () => {
  const calls = [];
  const request = async (_k, _b, path, opts) => { calls.push([path, opts?.body]); return {}; };
  const out = await updatePostHogEvents('phx', { posthog_api_base: 'https://us.posthog.com', posthog_project_id: '42', hog_function_id: 'fn1' },
    { signupEvent: 'account_created', keyEvents: 'report_created, invite_sent' }, { request });
  assert.deepEqual(out, { ok: true, signupEvent: 'account_created', keyEvents: ['report_created', 'invite_sent'], destination: true });
  assert.equal(calls[0][0], '/api/projects/42/hog_functions/fn1/');
  assert.deepEqual(calls[0][1].filters.events.map(e => e.id), ['account_created', 'report_created', 'invite_sent']);
  const none = await updatePostHogEvents('phx', { posthog_api_base: 'https://us.posthog.com', posthog_project_id: '42' }, { signupEvent: '', keyEvents: '' }, { request });
  assert.equal(none.destination, false, 'no destination: only the stored settings change');
  assert.equal(none.signupEvent, 'signed_up');
});
