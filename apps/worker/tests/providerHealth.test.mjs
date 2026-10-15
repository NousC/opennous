// Provider health for the backfill (GET-852): classify provider failures, count them, probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderError, providerFailures, probeProvider, PROVIDER_FAIL_THRESHOLD } from '../src/lib/providerHealth.mjs';

test('provider errors are told apart: credit, bad key, rate limit, outage', () => {
  assert.equal(classifyProviderError('openrouter 402: Insufficient credits. Add more using https://openrouter.ai/settings/credits'), 'credit');
  assert.equal(classifyProviderError('400 {"type":"error","error":{"message":"Your credit balance is too low"}}'), 'credit');
  assert.equal(classifyProviderError('openrouter 401: No auth credentials found'), 'auth');
  assert.equal(classifyProviderError('invalid x-api-key'), 'auth');
  assert.equal(classifyProviderError('openrouter 429: Rate limit exceeded'), 'rate_limit');
  assert.equal(classifyProviderError('openrouter timed out after 120000ms'), 'outage');
});

function fakeEvents(rows) {
  return { from: () => {
    const q = { select: () => q, eq: () => q, gte: () => q, order: () => q, limit: () => Promise.resolve({ data: rows, error: null }) };
    return q;
  } };
}

test('failures since the job started: count and the newest message', async () => {
  const f = await providerFailures(fakeEvents([
    { occurred_at: '2026-10-12T10:03:00Z', detail: { error: 'openrouter 402: Insufficient credits' } },
    { occurred_at: '2026-10-12T10:02:00Z', detail: { error: 'openrouter 402: Insufficient credits' } },
    { occurred_at: '2026-10-12T10:01:00Z', detail: { error: 'openrouter 402: Insufficient credits' } },
  ]), 'ws', '2026-10-12T10:00:00Z');
  assert.equal(f.count, 3);
  assert.ok(f.count >= PROVIDER_FAIL_THRESHOLD);
  assert.equal(f.last.reason, 'credit');
  assert.match(f.last.message, /Insufficient credits/);
  assert.deepEqual(await providerFailures(fakeEvents([]), 'ws', 'x'), { count: 0, last: null });
});

test('the probe: ok when the model answers, the reason when it does not', async () => {
  assert.deepEqual(await probeProvider(async () => ({ content: [{ type: 'text', text: 'ok' }] })), { ok: true });
  const bad = await probeProvider(async () => { throw new Error('openrouter 402: Insufficient credits'); });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'credit');
});
