// Review findings on the RevBox Job Builder (GET-868):
//   2. a `webhook` step never fetches a private or internal address. It goes through the registered
//      SSRF-guarded `safe_fetch` when there is one, and otherwise refuses private hosts itself.
//   7. a RevBox job always runs on the step engine (box context, box delivery), including an
//      AI-only job and a before_meeting job, which runs with the meeting as its context.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/automationWebhookSsrf.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { runStepsForTest as runSteps, registerStepHandler, flowRunsSteps, runScheduledFlow, assertPublicWebhookUrl } from '../dist/services/automationRun.mjs';

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

test('finding 7: a RevBox job always runs its steps, an ordinary AI-only routine still does not', () => {
  const aiOnly = [{ id: 'a', type: 'agent', config: { prompt: 'x' } }];
  assert.equal(flowRunsSteps({ steps: aiOnly }), false);
  assert.equal(flowRunsSteps({ steps: [] }), false);
  assert.equal(flowRunsSteps({ steps: [...aiOnly, { id: 's', type: 'slack', config: {} }] }), true);
  assert.equal(flowRunsSteps({ revbox_id: 'box', steps: aiOnly }), true);
  assert.equal(flowRunsSteps({ revbox_id: 'box', steps: [] }), true);
});

function database(seed = {}) {
  const tables = {
    workspace_members: [{ workspace_id: 'ws', user_id: 'owner', role: 'admin' }],
    revboxes: [{ id: 'box', workspace_id: 'ws', owner_id: 'owner', shared: true, name: 'CS', objective: 'Keep CS ahead.', blocks: [],
      delivery: [{ id: 'd-w', kind: 'webhook', target: 'https://hooks.example/cs' }] }],
    revbox_members: [], revbox_context: [], agent_routines: [], documents: [],
    ...seed,
  };
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select() { return this; } order() { return this; } limit() { return this; } gte() { return this; } not() { return this; } is() { return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    neq(k, v) { this.filters.push(r => r[k] !== v); return this; }
    in(k, vs) { this.filters.push(r => vs.includes(r[k])); return this; }
    insert() { return this; } update() { return this; }
    result(single) {
      const values = (tables[this.table] ??= []).filter(r => this.filters.every(f => f(r)));
      return { data: structuredClone(single ? values[0] ?? null : values), error: null };
    }
    maybeSingle() { return Promise.resolve(this.result(true)); }
    single() { return this.maybeSingle(); }
    then(ok, bad) { return Promise.resolve(this.result(false)).then(ok, bad); }
  }
  return { tables, from: t => new Query(t) };
}

test('finding 7: a before_meeting box job runs on the step engine with the meeting as its context', async () => {
  const hooks = [];
  registerStepHandler('safe_fetch', async (url, init) => { hooks.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; });
  try {
    const routine = { id: 'r1', name: 'Prep', user_id: 'owner', revbox_id: 'box', trigger_kind: 'before_meeting',
      steps: [{ id: 'box_delivery', type: 'revbox_delivery', config: {} }] };
    const meeting = { title: 'Acme renewal', when: '2026-10-15 09:00', with: 'Dana', company: 'Acme', entity_id: 'acme' };
    const row = await runScheduledFlow(database(), 'ws', routine, { runId: 'run-1', meeting, entityId: 'acme' });
    assert.equal(row.status, 'ok', row.error);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].url, 'https://hooks.example/cs');
    assert.equal(hooks[0].body.revbox_id, 'box');
    assert.match(hooks[0].body.text, /Acme renewal/);
    assert.match(hooks[0].body.text, /Dana/);
  } finally { registerStepHandler('safe_fetch', null); }
});

// ── Pre-ship finding 4 (GET-858): existing automations keep their redirects and time ──────────
// An ordinary webhook step and a legacy destination=webhook follow up to 4 redirects (each hop
// re-checked by the guard) with a 30s timeout, as before the guard; only a RevBox box webhook
// follows none and gives up after 8s.

test('pre-ship 4: a webhook step and a legacy webhook ask safe_fetch for 4 redirects and 30s; a box webhook for none and 8s', async () => {
  const { deliverLegacyForTest } = await import('../dist/services/automationRun.mjs');
  const seen = [];
  registerStepHandler('safe_fetch', async (url, init, opts) => { seen.push({ url, opts }); return { ok: true, status: 200 }; });
  try {
    await runSteps(hookFlow('https://hooks.example/won'), doc, { stage: 'deal_closed_won', ctx: null });
    await deliverLegacyForTest({ id: 'a2', destination: 'webhook', destination_target: 'https://hooks.example/legacy' }, doc, {});
    const sb = database();
    const r = await runSteps({ id: 'r1', name: 'Box', user_id: 'owner', revbox_id: 'box', steps: [{ id: 'box_delivery', type: 'revbox_delivery', config: {} }] },
      doc, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws', runId: 'run-9' } });
    assert.equal(r.failed, undefined, r.message);
    assert.deepEqual(seen.map(x => [x.url, x.opts]), [
      ['https://hooks.example/won', { maxRedirects: 4, timeoutMs: 30_000 }],
      ['https://hooks.example/legacy', { maxRedirects: 4, timeoutMs: 30_000 }],
      ['https://hooks.example/cs', { maxRedirects: 0, timeoutMs: 8_000 }],
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
