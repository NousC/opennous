// Pre-ship finding 4 (GET-858): the API registers core's `safe_fetch` with options. An ordinary
// automation's webhook step follows up to 4 redirects (each hop re-checked by the SSRF guard) with
// 30s, as before the guard; a RevBox box webhook follows none. A redirect into a private address is
// refused on either path. Real registration (routes/api/revboxes.mjs), fake network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/routes/api/revboxes.mjs';
// The same module instance @nous/core resolves to (its dist), for the engine's test entry point.
import { runStepsForTest as runSteps } from '../../../packages/core/dist/services/automationRun.mjs';

const doc = { id: 'd1', title: 'Won', headline: null, sections: [{ label: 'Summary', body: 'Signed.' }] };
const hookFlow = (url) => ({ id: 'a1', name: 'Hook', user_id: 'u1', steps: [{ id: 'w', type: 'webhook', config: { url } }] });

async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const hop = (to) => ({ ok: false, status: 302, headers: new Headers({ location: to }) });
const done = () => ({ ok: true, status: 200, headers: new Headers() });

test('a webhook step follows a public redirect through the registered safe_fetch', async () => {
  const seen = [];
  const r = await withFetch(async (url) => { seen.push(url); return url.endsWith('/final') ? done() : hop('https://93.184.216.35/final'); },
    () => runSteps(hookFlow('https://93.184.216.34/hook'), doc, { stage: 'deal_closed_won', ctx: null }));
  assert.equal(r.failed, undefined, r.message);
  assert.deepEqual(seen, ['https://93.184.216.34/hook', 'https://93.184.216.35/final']);
});

test('a webhook step\'s redirect into a private address is refused before it is fetched', async () => {
  const seen = [];
  const r = await withFetch(async (url) => { seen.push(url); return hop('http://169.254.169.254/latest/meta-data/'); },
    () => runSteps(hookFlow('https://93.184.216.34/hook'), doc, { stage: 'deal_closed_won', ctx: null }));
  assert.equal(r.failed, true);
  assert.deepEqual(seen, ['https://93.184.216.34/hook']);
});

function boxDb() {
  const tables = {
    workspace_members: [{ workspace_id: 'ws', user_id: 'owner', role: 'admin' }],
    revboxes: [{ id: 'box', workspace_id: 'ws', owner_id: 'owner', shared: true, name: 'CS', objective: '', blocks: [], delivery: [{ id: 'd-w', kind: 'webhook', target: 'https://93.184.216.34/box' }] }],
    revbox_members: [], revbox_context: [], agent_routines: [], documents: [],
  };
  class Q {
    constructor(t) { this.t = t; this.f = []; }
    select() { return this; } order() { return this; } limit() { return this; } not() { return this; } is() { return this; } insert() { return this; } update() { return this; }
    eq(k, v) { this.f.push(r => r[k] === v); return this; }
    neq(k, v) { this.f.push(r => r[k] !== v); return this; }
    in(k, vs) { this.f.push(r => vs.includes(r[k])); return this; }
    res(one) { const v = (tables[this.t] ??= []).filter(r => this.f.every(f => f(r))); return { data: structuredClone(one ? v[0] ?? null : v), error: null }; }
    maybeSingle() { return Promise.resolve(this.res(true)); }
    single() { return this.maybeSingle(); }
    then(ok, bad) { return Promise.resolve(this.res(false)).then(ok, bad); }
  }
  return { tables, from: t => new Q(t) };
}

test('a box webhook follows no redirect', async () => {
  const seen = [];
  const r = await withFetch(async (url) => { seen.push(url); return url.endsWith('/final') ? done() : hop('https://93.184.216.35/final'); },
    () => runSteps({ id: 'r1', name: 'Box', user_id: 'owner', revbox_id: 'box', steps: [{ id: 'box_delivery', type: 'revbox_delivery', config: {} }] },
      doc, { stage: 'scheduled', ctx: { supabase: boxDb(), workspaceId: 'ws', runId: 'run-1' } }));
  assert.equal(r.failed, true);
  assert.match(r.message, /too many redirects/);
  assert.deepEqual(seen, ['https://93.184.216.34/box']);
});
