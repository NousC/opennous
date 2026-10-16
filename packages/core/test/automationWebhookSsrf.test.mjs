// Review findings on the automation engine (GET-868):
//   2. a `webhook` step never fetches a private or internal address. It goes through the registered
//      SSRF-guarded `safe_fetch` when there is one, and otherwise refuses private hosts itself.
//   7. an ordinary AI-only routine does not run on the step engine; one with any other step does.
// Cloud's halves of these live in test/cloud/ (GET-910).
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/automationWebhookSsrf.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { runStepsForTest as runSteps, registerStepHandler, flowRunsSteps, assertPublicWebhookUrl } from '../dist/services/automationRun.mjs';

const doc = { id: 'd1', title: 'Won: Acme', headline: null, sections: [{ label: 'Summary', body: 'Acme signed.' }] };
const hookFlow = (url) => ({ id: 'a1', name: 'Hook', user_id: 'u1', steps: [{ id: 'w', type: 'webhook', config: { url } }] });

/** Swap global fetch for the length of one test. */
async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('finding 2: a webhook step posts through the registered safe_fetch, never a bare fetch', async () => {
  const seen = [];
  registerStepHandler('safe_fetch', async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200 }; });
  let bare = 0;
  try {
    const r = await withFetch(async () => { bare++; return { ok: true, status: 200 }; },
      () => runSteps(hookFlow('https://hooks.example/won'), doc, { stage: 'deal_closed_won', ctx: null }));
    assert.equal(r.failed, undefined, r.message);
    assert.equal(bare, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://hooks.example/won');
    assert.equal(JSON.parse(seen[0].init.body).document_id, 'd1');
  } finally { registerStepHandler('safe_fetch', null); }
});

test('finding 2: with no safe_fetch registered, private and internal hosts are refused before any request', async () => {
  registerStepHandler('safe_fetch', null);
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:5432/',
    'http://10.0.0.5/hook',
    'http://[::1]/hook',
    'http://localhost:3000/internal',
    'http://redis/',
    'http://api.internal/hook',
    'file:///etc/passwd',
  ]) {
    let bare = 0;
    const r = await withFetch(async () => { bare++; return { ok: true, status: 200 }; },
      () => runSteps(hookFlow(url), doc, { stage: 'deal_closed_won', ctx: null }));
    assert.equal(bare, 0, url);
    assert.equal(r.failed, true, url);
    assert.match(r.message ?? r.reason, /webhook failed/i, url);
  }
});

test('finding 2: an ordinary automation still posts to a public https URL', async () => {
  registerStepHandler('safe_fetch', null);
  const seen = [];
  const r = await withFetch(async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, headers: new Headers() }; },
    () => runSteps(hookFlow('https://93.184.216.34/hook'), doc, { stage: 'deal_closed_won', ctx: null }));
  assert.equal(r.failed, undefined, r.message);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://93.184.216.34/hook');
  assert.equal(seen[0].init.redirect, 'manual');   // a redirect is re-checked, never followed blind
});

test('finding 2: the fallback guard re-checks a redirect and refuses one into a private address', async () => {
  registerStepHandler('safe_fetch', null);
  const seen = [];
  const r = await withFetch(async (url) => {
    seen.push(url);
    return { ok: false, status: 302, headers: new Headers({ location: 'http://169.254.169.254/latest/' }) };
  }, () => runSteps(hookFlow('https://93.184.216.34/hook'), doc, { stage: 'deal_closed_won', ctx: null }));
  assert.deepEqual(seen, ['https://93.184.216.34/hook']);
  assert.equal(r.failed, true);
});

test('finding 2: assertPublicWebhookUrl is the shared guard (mirrors apps/api/src/lib/ssrf.mjs)', async () => {
  await assert.rejects(assertPublicWebhookUrl('http://192.168.1.1/'), /blocked_private_address/);
  await assert.rejects(assertPublicWebhookUrl('http://[::ffff:127.0.0.1]/'), /blocked_private_address/);
  await assert.rejects(assertPublicWebhookUrl('gopher://x.example/'), /blocked_url_protocol/);
  assert.equal((await assertPublicWebhookUrl('https://93.184.216.34/x')).hostname, '93.184.216.34');
});

// ── Finding 7 ────────────────────────────────────────────────────────────────

test('finding 7: an ordinary AI-only routine does not run its steps; one with another step does', () => {
  const aiOnly = [{ id: 'a', type: 'agent', config: { prompt: 'x' } }];
  assert.equal(flowRunsSteps({ steps: aiOnly }), false);
  assert.equal(flowRunsSteps({ steps: [] }), false);
  assert.equal(flowRunsSteps({ steps: [...aiOnly, { id: 's', type: 'slack', config: {} }] }), true);
});

// ── Pre-ship finding 4 (GET-858): existing automations keep their redirects and time ──────────
// An ordinary webhook step and a legacy destination=webhook follow up to 4 redirects (each hop
// re-checked by the guard) with a 30s timeout, as before the guard.

test('pre-ship 4: a webhook step and a legacy webhook ask safe_fetch for 4 redirects and 30s', async () => {
  const { deliverLegacyForTest } = await import('../dist/services/automationRun.mjs');
  const seen = [];
  registerStepHandler('safe_fetch', async (url, init, opts) => { seen.push({ url, opts }); return { ok: true, status: 200 }; });
  try {
    await runSteps(hookFlow('https://hooks.example/won'), doc, { stage: 'deal_closed_won', ctx: null });
    await deliverLegacyForTest({ id: 'a2', destination: 'webhook', destination_target: 'https://hooks.example/legacy' }, doc, {});
    assert.deepEqual(seen.map(x => [x.url, x.opts]), [
      ['https://hooks.example/won', { maxRedirects: 4, timeoutMs: 30_000 }],
      ['https://hooks.example/legacy', { maxRedirects: 4, timeoutMs: 30_000 }],
    ]);
  } finally { registerStepHandler('safe_fetch', null); }
});

test('pre-ship 4: the fallback guard follows a webhook step\'s public redirect, re-checks each hop, refuses a private one', async () => {
  registerStepHandler('safe_fetch', null);
  const seen = [];
  const hops = { 'https://93.184.216.34/hook': 'https://93.184.216.35/moved', 'https://93.184.216.35/moved': null };
  const ok = await withFetch(async (url) => {
    seen.push(url);
    return hops[url] ? { ok: false, status: 307, headers: new Headers({ location: hops[url] }) } : { ok: true, status: 200, headers: new Headers() };
  }, () => runSteps(hookFlow('https://93.184.216.34/hook'), doc, { stage: 'deal_closed_won', ctx: null }));
  assert.equal(ok.failed, undefined, ok.message);
  assert.deepEqual(seen, ['https://93.184.216.34/hook', 'https://93.184.216.35/moved']);
  // Through a public hop into a private address: refused at that hop, never fetched.
  const seen2 = [];
  const bad = await withFetch(async (url) => {
    seen2.push(url);
    return url === 'https://93.184.216.34/hook'
      ? { ok: false, status: 302, headers: new Headers({ location: 'https://93.184.216.35/next' }) }
      : { ok: false, status: 302, headers: new Headers({ location: 'http://10.0.0.7/admin' }) };
  }, () => runSteps(hookFlow('https://93.184.216.34/hook'), doc, { stage: 'deal_closed_won', ctx: null }));
  assert.equal(bad.failed, true);
  assert.deepEqual(seen2, ['https://93.184.216.34/hook', 'https://93.184.216.35/next']);
  // More than 4 redirects: refused.
  let n = 0;
  const loop = await withFetch(async () => { n++; return { ok: false, status: 302, headers: new Headers({ location: `https://93.184.216.34/r${n}` }) }; },
    () => runSteps(hookFlow('https://93.184.216.34/hook'), doc, { stage: 'deal_closed_won', ctx: null }));
  assert.equal(loop.failed, true);
  assert.equal(n, 5);
});
