// API-plan notification emails (GET-635): the copy, and that the worker only sends what the api queued.
//
// Run: node --test apps/worker/tests/apiNotificationEmails.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { template, runApiNotificationEmails } from '../src/workers/apiNotificationEmails.mjs';

test('webhook failures: names the endpoint, the count and the last status', () => {
  const t = template({ kind: 'webhook_failures', subscriptionName: 'CRM sync', url: 'https://a.example/hook', failures: 3, lastStatus: 500 });
  assert.equal(t.subject, 'Your webhook "CRM sync" keeps returning errors');
  assert.match(t.text, /The last 3 deliveries to "CRM sync" \(https:\/\/a\.example\/hook\) failed\. The last attempt got a 500\./);
  assert.match(t.text, /\/webhooks/);
});

test('key expiring: names the key and the day', () => {
  const t = template({ kind: 'key_expiring', keyName: 'prod', expiresAt: '2026-10-09T10:00:00Z' });
  assert.equal(t.subject, 'Your API key "prod" expires on 9 October');
  assert.match(t.text, /\/keys/);
});

test('credits low: the numbers, plainly', () => {
  const t = template({ kind: 'credits_low', used: 1600, included: 2000, percentUsed: 80 });
  assert.equal(t.subject, "You've used 80% of this month's credits");
  assert.match(t.text, /1,600 of the 2,000 credits/);
  assert.match(t.text, /\/usage/);
});

test('html escapes what the customer named', () => {
  const t = template({ kind: 'key_expiring', keyName: '<b>x</b>', expiresAt: '2026-10-09T10:00:00Z' });
  assert.ok(!t.html.includes('<b>x</b>'));
});

test('sends each queued alert to each recipient, and nothing without the secret', async () => {
  const sent = [];
  const send = async (m) => { sent.push(m.to); return { sent: true }; };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ queued: [
    { kind: 'credits_low', to: ['a@x.example', 'b@x.example'], used: 1, included: 2, percentUsed: 80 },
  ] }) });
  const prev = { s: process.env.WORKER_INTERNAL_SECRET, u: process.env.API_URL };
  try {
    delete process.env.WORKER_INTERNAL_SECRET;
    await runApiNotificationEmails(['credits_low'], { fetchImpl, send });
    assert.deepEqual(sent, []);
    process.env.WORKER_INTERNAL_SECRET = 's'; process.env.API_URL = 'http://api';
    await runApiNotificationEmails(['credits_low'], { fetchImpl, send });
    assert.deepEqual(sent, ['a@x.example', 'b@x.example']);
  } finally {
    if (prev.s === undefined) delete process.env.WORKER_INTERNAL_SECRET; else process.env.WORKER_INTERNAL_SECRET = prev.s;
    if (prev.u === undefined) delete process.env.API_URL; else process.env.API_URL = prev.u;
  }
});
