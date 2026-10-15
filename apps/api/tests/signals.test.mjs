// /api/signals (GET-862): the signal catalog and the workspace's own signals, at workspace level.
// The router runs with its guards and database injected: no auth server, no plan, no Postgres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { makeWorkspaceSignalsRouter, signalsRouter } from '../src/routes/api/signals.mjs';

const ID = (n) => `0000000${n}-0000-4000-8000-000000000000`;

/** In-memory tables behind the same query surface the core functions use. */
function fakeDb() {
  const tables = { workspace_members: [{ workspace_id: 'ws', user_id: 'u1' }, { workspace_id: 'ws', user_id: 'u2' }], custom_signal_definitions: [] };
  let n = 0;
  return { tables, from(table) {
    const filters = []; let mode = 'select', payload = null, limit = null;
    const run = (single) => {
      const rows = tables[table] ?? (tables[table] = []);
      if (mode === 'insert') {
        if (rows.some(r => r.workspace_id === payload.workspace_id && r.key === payload.key)) return { data: null, error: { code: '23505' } };
        const row = { id: ID(++n), archived_at: null, ...structuredClone(payload) }; rows.push(row); return { data: structuredClone(row), error: null };
      }
      let found = rows.filter(r => filters.every(f => f(r)));
      if (mode === 'update') for (const r of found) Object.assign(r, structuredClone(payload));
      if (limit != null) found = found.slice(0, limit);
      if (single === 'single' && !found.length) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      return { data: structuredClone(single ? found[0] ?? null : found), error: null };
    };
    const q = {
      select: () => q, order: () => q, range: () => q, limit: (k) => { limit = k; return q; },
      eq: (k, v) => { filters.push(r => r[k] === v); return q; }, is: (k, v) => { filters.push(r => (r[k] ?? null) === v); return q; },
      insert: (row) => { mode = 'insert'; payload = row; return q; }, update: (p) => { mode = 'update'; payload = p; return q; },
      maybeSingle: () => Promise.resolve(run('maybe')), single: () => Promise.resolve(run('single')),
      then: (res, rej) => Promise.resolve(run(false)).then(res, rej),
    };
    return q;
  } };
}

async function serve({ db = fakeDb(), user = 'u1', guards, creditGate = async () => {}, connected = ['granola', 'hubspot', 'slack'] } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = 'ws'; req.internalUserId = req.headers['x-user'] ?? user; next(); });
  app.use('/api/signals', makeWorkspaceSignalsRouter({ getSb: () => db, guards: guards ?? [], creditGate, connectedSlugs: async () => connected }));
  app.use('/api/signals', (req, res) => res.status(418).json({ fellThrough: req.path }));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/signals`;
  const call = async (method, path = '', body, as) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(as ? { 'x-user': as } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  return { db, call, close: () => new Promise(r => server.close(r)) };
}

test('catalog: built-ins grouped with their triggers, plus the workspace\'s live custom signals', async () => {
  const srv = await serve();
  try {
    await srv.call('POST', '', { name: 'Security review', rule: 'The buyer asks for a security review.' });
    const r = await srv.call('GET', '/catalog');
    assert.equal(r.status, 200);
    const meeting = r.body.builtin.find(e => e.key === 'meeting.done');
    assert.deepEqual(meeting.trigger, { kind: 'call_ended', config: {} });
    assert.ok(meeting.providers.includes('granola'));
    assert.ok(r.body.builtin.some(e => e.key === 'schedule' && e.trigger.kind === 'clock'));
    assert.ok(r.body.builtin.some(e => e.key === 'signal.churn_risk'));
    assert.deepEqual(r.body.custom.map(e => e.key), ['custom.security_review']);
    assert.deepEqual(r.body.custom[0].trigger, { kind: 'account_signal', config: { signals: [`custom_${srv.db.tables.custom_signal_definitions[0].id}`] } });
    assert.ok(r.body.groups.some(g => g.id === 'meetings'));
  } finally { await srv.close(); }
});

test('catalog: meeting signals list only the connected recorders, and the connected sources come along (GET-892)', async () => {
  const none = await serve({ connected: ['hubspot', 'slack'] });
  try {
    const r = await none.call('GET', '/catalog');
    assert.deepEqual(r.body.builtin.find(e => e.key === 'meeting.done').providers, []);
    assert.deepEqual(r.body.recorders, []);
    assert.deepEqual(r.body.connected, ['hubspot', 'slack']);
  } finally { await none.close(); }
  const two = await serve({ connected: ['fireflies', 'gmail', 'granola'] });
  try {
    const r = await two.call('GET', '/catalog');
    assert.deepEqual(r.body.builtin.find(e => e.key === 'meeting.done').providers, ['granola', 'fireflies', 'any']);
    assert.deepEqual(r.body.recorders, ['granola', 'fireflies']);
    assert.deepEqual(r.body.connected, ['fireflies', 'gmail', 'granola']);
  } finally { await two.close(); }
});

test('create needs no RevBox; edit is owner-only; archive hides it from the catalog and keeps the key', async () => {
  const srv = await serve();
  try {
    const created = await srv.call('POST', '', { name: 'Pricing pushback', rule: 'Price is too high.', sources: ['granola'] });
    assert.equal(created.status, 201);
    const s = created.body.signal;
    assert.equal(s.key, 'pricing_pushback'); assert.equal(s.revbox_id, null); assert.equal(s.archived, false);
    const notOwner = await srv.call('PUT', `/${s.id}`, { ...s, rule: 'Changed.' }, 'u2');
    assert.equal(notOwner.status, 403);
    const edited = await srv.call('PUT', `/${s.id}`, { ...s, rule: 'Price objection.', active: true });
    assert.equal(edited.status, 200); assert.equal(edited.body.signal.version, 2); assert.equal(edited.body.signal.active, true);
    const archived = await srv.call('POST', `/${s.id}/archive`);
    assert.equal(archived.status, 200); assert.equal(archived.body.signal.archived, true); assert.equal(archived.body.signal.active, false);
    assert.deepEqual((await srv.call('GET', '/catalog')).body.custom, []);
    const list = await srv.call('GET', '');
    assert.equal(list.body.signals.length, 1); assert.equal(list.body.signals[0].archived, true);
    const reuse = await srv.call('POST', '', { name: 'Pricing pushback', rule: 'Something else.' });
    assert.equal(reuse.body.signal.key, 'pricing_pushback_2');
    const reactivate = await srv.call('PUT', `/${s.id}`, { ...archived.body.signal, active: true });
    assert.equal(reactivate.status, 409);
  } finally { await srv.close(); }
});

test('a non-member is refused; a bad id is a 400', async () => {
  const srv = await serve({ user: 'stranger' });
  try {
    assert.equal((await srv.call('GET', '/catalog')).status, 403);
    assert.equal((await srv.call('PUT', '/not-a-uuid', { name: 'x', rule: 'y' }, 'u1')).status, 400);
  } finally { await srv.close(); }
});

test('reprocess is credit-gated before any work', async () => {
  let gated = 0;
  const srv = await serve({ creditGate: async () => { gated++; throw Object.assign(new Error('Out of credits.'), { status: 402 }); } });
  try {
    const s = (await srv.call('POST', '', { name: 'Churn', rule: 'Leaving.', active: true })).body.signal;
    const r = await srv.call('POST', `/${s.id}/reprocess`, { since: new Date().toISOString() });
    assert.equal(r.status, 402); assert.equal(gated, 1);
    assert.equal(srv.db.tables.custom_signal_definitions[0].version, 1);
  } finally { await srv.close(); }
});

test('the guards run per route, and paths this router does not own fall through (webhook-url)', async () => {
  const blocked = await serve({ guards: [(_req, res) => res.status(402).json({ error: 'feature_not_in_plan' })] });
  try {
    assert.equal((await blocked.call('GET', '/catalog')).status, 402);
    const other = await blocked.call('GET', '/webhook-url');
    assert.equal(other.status, 418); assert.equal(other.body.fellThrough, '/webhook-url');
  } finally { await blocked.close(); }
  assert.ok(signalsRouter.stack.some(l => l.route?.path === '/webhook-url'));
});
