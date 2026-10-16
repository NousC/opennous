// Pre-ship finding 4 (GET-858): the API registers core's `safe_fetch` with options. An ordinary
// automation's webhook step follows up to 4 redirects (each hop re-checked by the SSRF guard) with
// 30s, as before the guard. A redirect into a private address is refused. Real registration
// (lib/engineStepHandlers.mjs), fake network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/lib/engineStepHandlers.mjs';
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
