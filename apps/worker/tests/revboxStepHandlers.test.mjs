// Review finding 6 on the RevBox Job Builder (GET-868): the worker runs event-triggered RevBox jobs,
// so it registers the two handlers the step engine needs for them, as the API does
// (apps/api/src/routes/api/revboxes.mjs): `safe_fetch` (box webhooks, through the SSRF guard) and
// `revbox_visible_accounts` (the owner's visible accounts, for account-scoped box references).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerRevboxStepHandlers, assertPublicUrl } from '../src/lib/revboxStepHandlers.mjs';
import { fakeDb } from './fakeDb.mjs';

function registered() {
  const h = {};
  registerRevboxStepHandlers((type, fn) => { h[type] = fn; });
  return h;
}

test('the worker registers safe_fetch and revbox_visible_accounts', () => {
  const h = registered();
  assert.equal(typeof h.safe_fetch, 'function');
  assert.equal(typeof h.revbox_visible_accounts, 'function');
});

test('the index registers them at boot', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
  assert.match(src, /registerRevboxStepHandlers\(registerStepHandler\)/);
});

test('safe_fetch refuses private and internal addresses before any request, and follows no redirect', async () => {
  const { safe_fetch } = registered();
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, headers: new Headers() }; };
  try {
    for (const url of ['http://169.254.169.254/latest/', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://localhost/', 'http://redis:6379/', 'http://[::1]/', 'ftp://x.example/']) {
      await assert.rejects(safe_fetch(url, { method: 'POST' }), /blocked|invalid/, url);
    }
    assert.equal(seen.length, 0);
    const r = await safe_fetch('https://93.184.216.34/hook', { method: 'POST', body: '{}' });
    assert.equal(r.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].init.redirect, 'manual');
    // A redirect is never followed (the API registers maxRedirects: 0 too), least of all into a private address.
    globalThis.fetch = async (url) => { seen.push({ url }); return { ok: false, status: 302, headers: new Headers({ location: 'http://169.254.169.254/' }) }; };
    await assert.rejects(safe_fetch('https://93.184.216.34/hook', { method: 'POST' }), /blocked_private_address|too_many_redirects/);
    assert.equal(seen.length, 2);
  } finally { globalThis.fetch = real; }
  await assert.rejects(assertPublicUrl('http://192.168.0.1/'), /blocked_private_address/);
});

const owner = (uid) => ({ workspace_id: 'ws', entity_id: 'acme', property: 'relationship_owner', invalid_at: null, value: { primary: uid, members: [] } });

test('revbox_visible_accounts: the owner\'s visible accounts, as the API reads them', async () => {
  const { revbox_visible_accounts: see } = registered();
  // No owner: nothing account-scoped.
  assert.deepEqual([...(await see({ supabase: fakeDb({}), workspaceId: 'ws', userId: null }))], []);
  // An open workspace: every account (null).
  const open = fakeDb({ workspaces: [{ id: 'ws', open_account_visibility: true }], workspace_members: [{ workspace_id: 'ws', user_id: 'm1', role: 'member' }] });
  assert.equal(await see({ supabase: open, workspaceId: 'ws', userId: 'm1' }), null);
  // A closed workspace: a member sees their own book (the account they own, and its contacts' company).
  const closed = fakeDb({
    workspaces: [{ id: 'ws', open_account_visibility: false }],
    workspace_members: [{ workspace_id: 'ws', user_id: 'm1', role: 'member' }, { workspace_id: 'ws', user_id: 'a1', role: 'admin' }],
    claims: [owner('m1')],
    contacts: [{ id: 'acme', company_id: 'acme-co' }],
  });
  const ids = await see({ supabase: closed, workspaceId: 'ws', userId: 'm1' });
  assert.ok(ids instanceof Set);
  assert.deepEqual([...ids].sort(), ['acme', 'acme-co']);
  // An admin of a closed workspace sees every account.
  assert.equal(await see({ supabase: closed, workspaceId: 'ws', userId: 'a1' }), null);
});

// Pre-ship finding 4 (GET-858): safe_fetch takes { maxRedirects, timeoutMs }. An ordinary webhook
// step asks for 4 redirects and 30s (as before the guard), a box webhook for none; every hop is
// re-checked, so a redirect into a private address is still refused.
test('safe_fetch options: up to maxRedirects public hops are followed, a private hop is refused, the default follows none', async () => {
  const { safe_fetch } = registered();
  const real = globalThis.fetch;
  const seen = [];
  const hop = (to) => ({ ok: false, status: 302, headers: new Headers({ location: to }) });
  try {
    globalThis.fetch = async (url) => { seen.push(url); return url.endsWith('/final') ? { ok: true, status: 200, headers: new Headers() } : hop('https://93.184.216.35/final'); };
    const r = await safe_fetch('https://93.184.216.34/hook', { method: 'POST' }, { maxRedirects: 4, timeoutMs: 30_000 });
    assert.equal(r.status, 200);
    assert.deepEqual(seen, ['https://93.184.216.34/hook', 'https://93.184.216.35/final']);
    // No options: a box webhook's default, no redirect followed.
    seen.length = 0;
    await assert.rejects(safe_fetch('https://93.184.216.34/hook', { method: 'POST' }), /too_many_redirects/);
    assert.deepEqual(seen, ['https://93.184.216.34/hook']);
    // A public hop, then a private one: refused before it is fetched.
    seen.length = 0;
    globalThis.fetch = async (url) => { seen.push(url); return url.endsWith('/hook') ? hop('https://93.184.216.35/next') : hop('http://169.254.169.254/latest/'); };
    await assert.rejects(safe_fetch('https://93.184.216.34/hook', {}, { maxRedirects: 4 }), /blocked_private_address/);
    assert.deepEqual(seen, ['https://93.184.216.34/hook', 'https://93.184.216.35/next']);
    // Never more than 4, whatever is asked; and the timeout is passed to the request.
    seen.length = 0;
    globalThis.fetch = async (url, init) => { seen.push(url); assert.ok(init.signal); return hop(`https://93.184.216.34/r${seen.length}`); };
    await assert.rejects(safe_fetch('https://93.184.216.34/hook', {}, { maxRedirects: 50 }), /too_many_redirects/);
    assert.equal(seen.length, 5);
  } finally { globalThis.fetch = real; }
});
