// PostHog as a source (GET-751): the worker's half. A connection's settings read the same
// whether subscribe stored its plain copies or not, the daily pull runs once a day, a day's facts
// are idempotent, and the inbound secret is compared in constant time.
//
// Run: node --test apps/worker/tests/posthog.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionSettings, isDue, usageObservations, majorityCompany, pullConnection, weekOf, productUsedActivity } from '../src/pollers/posthog.mjs';
import { secretMatches } from '../src/webhooks/handlers/posthog.mjs';

// Stands in for decrypt(): "enc:" values are ciphertext, anything else comes back as it is.
const fakeDecrypt = (v) => (v == null ? null : String(v).startsWith('enc:') ? String(v).slice(4) : v);

test('settings from the encrypted form alone, when subscribe could not store its copies', () => {
  const { apiKey, read } = connectionSettings({ api_key: 'enc:phx_live', host: 'enc:eu', project_id: 'enc:42', key_events: 'enc:report_created' }, fakeDecrypt);
  assert.equal(apiKey, 'phx_live');
  assert.deepEqual(read.settings, { apiBase: 'https://eu.posthog.com', projectId: '42', signupEvent: 'signed_up', keyEvents: ['report_created'] });
});

test('settings prefer subscribe\'s plain copies over the form', () => {
  const { read } = connectionSettings({
    api_key: 'enc:phx_live', host: 'enc:us', project_id: 'enc:1',
    posthog_api_base: 'https://eu.posthog.com', posthog_project_id: '42', signup_event: 'account_created', key_events: 'invite_sent',
  }, fakeDecrypt);
  assert.deepEqual(read.settings, { apiBase: 'https://eu.posthog.com', projectId: '42', signupEvent: 'account_created', keyEvents: ['invite_sent'] });
});

test('a connection is pulled when it never was, or 20 hours after the last pull', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  assert.equal(isDue({}, now), true);
  assert.equal(isDue({ posthog_last_pull_at: '2026-10-18T02:00:00Z' }, now), false);
  assert.equal(isDue({ posthog_last_pull_at: '2026-10-17T15:59:00Z' }, now), true);
});

test('a day\'s facts are state observations whose id names the day, and empty facts are dropped', () => {
  const obs = usageObservations('ws1', 'acct-1', [['cs.active_users_30d', 3], ['cs.last_used_at', null], ['product.key_events', null]], '2026-10-18');
  assert.deepEqual(obs, [{
    workspaceId: 'ws1', entityId: 'acct-1', kind: 'state', property: 'cs.active_users_30d', value: 3,
    source: 'posthog', method: 'usage_pull', observedAt: '2026-10-18T00:00:00.000Z',
    externalId: 'posthog_usage_2026-10-18_acct-1_cs.active_users_30d',
  }]);
  assert.equal(usageObservations('ws1', 'acct-1', [['cs.active_users_30d', 0]], '2026-10-18').length, 1, 'a zero is a fact');
});

test('a domain\'s account is the one most of its people already belong to', () => {
  assert.equal(majorityCompany(['a', 'b', 'a', null]), 'a');
  assert.equal(majorityCompany([null, undefined]), null);
});

test('the inbound secret must match exactly', () => {
  assert.equal(secretMatches('s3cret', 's3cret'), true);
  assert.equal(secretMatches('s3cre', 's3cret'), false);
  assert.equal(secretMatches(undefined, 's3cret'), false);
  assert.equal(secretMatches('', ''), false);
});

/**
 * A stand-in for supabase-js: each from() chain records its filters and answers from `answer`,
 * which sees the table and the filters. update() is recorded in `updates`.
 */
function fakeDb(answer) {
  const updates = [];
  const db = {
    updates,
    from(table) {
      const f = { table, ops: [] };
      const q = {
        then: (ok, bad) => Promise.resolve(answer(f)).then(ok, bad),
        maybeSingle: () => Promise.resolve(answer({ ...f, single: true })),
        update: (v) => { f.update = v; return q; },
        upsert: (rows) => { (db.upserts ??= []).push({ table, rows }); return Promise.resolve({ error: null }); },
      };
      for (const op of ['select', 'eq', 'in', 'neq', 'limit', 'like', 'order', 'range', 'gte']) {
        q[op] = (...args) => { f.ops.push([op, ...args]); if (op === 'eq' && f.update) updates.push({ table, set: f.update, where: args }); return q; };
      }
      return q;
    },
  };
  return db;
}

const day = '2026-10-18';
const conn = {
  id: 'conn-1', workspace_id: 'ws1',
  encrypted_credentials: { api_key: 'phx_live', posthog_api_base: 'https://us.posthog.com', posthog_project_id: '42', key_events: '', posthog_last_pull_at: '2026-10-17T00:41:00.000Z' },
};
const rowsFromPostHog = [
  // email, last_seen, active_days_30d, active_days_7d, events_30d, events_prev_30d
  ['sorrel@harborline.example', '2026-10-17T12:00:00Z', 12, 3, 140, 90],
  ['solo@gmail.com', '2026-10-18T08:00:00Z', 4, 1, 20, 0],
  ['us@ourco.example', '2026-10-18T08:00:00Z', 30, 7, 900, 800],
  ['founder@gmail.com', '2026-10-18T08:00:00Z', 30, 7, 2000, 1900],
];

test('the daily pull: own team (domains and members) skipped, free mail never created, a CRM keeps its fields, quiet accounts zeroed, cursor on the fresh row', async () => {
  const resolved = [];
  const recorded = [];
  const used = [];
  const db = fakeDb((f) => {
    const has = (op, ...a) => f.ops.some(o => o[0] === op && a.every((x, i) => o[i + 1] === x));
    if (f.table === 'observations' && has('neq', 'source', 'posthog')) return { data: [{ entity_id: 'acct-harbor', property: 'cs.active_users_30d' }] };
    if (f.table === 'observations' && has('like', 'external_id', 'posthog_usage_2026-10-17_%') && has('eq', 'property', 'product.user')) return { data: [{ entity_id: 'p-sorrel' }, { entity_id: 'p-left' }] };
    if (f.table === 'observations' && has('like', 'external_id', 'posthog_usage_2026-10-17_%')) return { data: [{ entity_id: 'acct-harbor' }, { entity_id: 'acct-gone' }] };
    if (f.table === 'workflow_provider_connections' && f.single) return { data: { encrypted_credentials: { ...conn.encrypted_credentials, webhook_secret: 'NEW' } } };
    return { data: [] };
  });
  const out = await pullConnection(db, conn, {
    now: new Date(`${day}T00:41:00Z`),
    request: async () => ({ results: rowsFromPostHog }),
    checkHost: async () => { throw new Error('a posthog.com host is not re-checked'); },
    ownDomains: async () => new Set(['ourco.example']),
    members: async () => new Set(['founder@gmail.com']),
    logUse: async (_s, a) => { used.push(a); },
    resolve: async (_s, _ws, data, opts) => {
      resolved.push([data.email, opts.createIfMissing, opts.enrich]);
      return data.email === 'sorrel@harborline.example' ? { contact: { id: 'p-sorrel', company_id: 'acct-harbor' }, created: true } : { contact: null };
    },
    upsert: async () => { throw new Error('the account is known through its person'); },
    record: async (_s, rows) => { recorded.push(...rows); return rows.length; },
  });

  // A work-email user is created on their account; a free-mail user with no company anywhere is
  // created with enrichment on, so the lookup finds it.
  assert.deepEqual(resolved, [['sorrel@harborline.example', true, false], ['solo@gmail.com', true, true]]);
  assert.deepEqual(out, { ok: true, users: 2, people: 1, created: 1, accounts: 1, quiet: 1, signals: 0, issues: 0 });

  const on = (id) => Object.fromEntries(recorded.filter(r => r.entityId === id).map(r => [r.property, r.value]));
  const harbor = on('acct-harbor');
  assert.equal(harbor['cs.active_users_30d'], undefined, 'the CRM writes this one');
  assert.equal(harbor['product.active_users_30d'], 1);
  assert.equal(harbor['cs.total_users'], 1);
  assert.equal(on('p-sorrel')['product.active_days_30d'], 12);
  assert.equal(on('p-sorrel')['product.user'], true);
  assert.equal(on('p-left')['product.user'], false, 'a user in the last pull and gone from this window is no longer one');
  const gone = on('acct-gone');
  assert.equal(gone['product.active_users_30d'], 0);
  assert.equal(gone['product.active_users_prev_30d'], 0);
  assert.deepEqual(gone['product.key_events'], {});
  assert.ok(recorded.every(r => r.externalId.startsWith(`posthog_usage_${day}_`)));

  assert.equal(used.length, 1, 'one weekly product use, for the person active this week');
  assert.equal(used[0].type, 'product_used');
  assert.equal(used[0].externalId, 'posthog_used_p-sorrel_2026-10-12');
  assert.equal(used[0].companyId, 'acct-harbor');

  assert.equal(db.updates.length, 1);
  assert.equal(db.updates[0].set.encrypted_credentials.webhook_secret, 'NEW', 'a reconnect during the pull is kept');
  assert.equal(db.updates[0].set.encrypted_credentials.posthog_last_pull_at, `${day}T00:41:00.000Z`);
});

test('a self-hosted PostHog is re-checked before every pull', async () => {
  const self = { ...conn, encrypted_credentials: { ...conn.encrypted_credentials, posthog_api_base: 'https://ph.harborline.example' } };
  await assert.rejects(pullConnection(fakeDb(() => ({ data: [] })), self, {
    checkHost: async () => { throw new Error('blocked_private_address'); },
    request: async () => { throw new Error('must not call'); },
  }), /blocked_private_address/);
});

test('a week starts on Monday, in UTC', () => {
  assert.equal(weekOf(new Date('2026-10-18T23:00:00Z')), '2026-10-12');   // a Sunday
  assert.equal(weekOf(new Date('2026-10-19T00:30:00Z')), '2026-10-19');   // the Monday after
});

test('anyone active in the last 30 days gets a product use, keyed to the week they were last seen', () => {
  const u = { activeDays7d: 2, activeDays30d: 9, events30d: 40, lastSeen: '2026-10-17T10:00:00.000Z' };
  const a = productUsedActivity('ws1', { id: 'p1', company_id: 'c1' }, u, new Date('2026-10-18T00:41:00Z'));
  assert.equal(a.description, 'Used the product on 2 of the last 7 days');
  assert.equal(a.occurredAt, '2026-10-18T00:41:00.000Z', 'dated when read, so its stage beats the identified written this pull');
  assert.equal(a.rawData.last_seen_at, '2026-10-17T10:00:00.000Z');
  assert.equal(a.externalId, 'posthog_used_p1_2026-10-12');
  const older = productUsedActivity('ws1', { id: 'p1' }, { ...u, activeDays7d: 0, activeDays30d: 1, lastSeen: '2026-10-11T02:47:30.857Z' }, new Date('2026-10-19T00:41:00Z'));
  assert.equal(older.description, 'Used the product on 1 of the last 30 days');
  assert.equal(older.externalId, 'posthog_used_p1_2026-10-05', 'dated to the week they were last seen');
  assert.equal(productUsedActivity('ws1', { id: 'p1' }, { ...u, activeDays7d: 0, activeDays30d: 0 }), null);
  assert.equal(productUsedActivity('ws1', null, u), null);
});

test('issues become Product insights per account and week; our own team and unknown people are left out', async () => {
  const { pullIssues } = await import('../src/pollers/posthog.mjs');
  const written = [];
  const n = await pullIssues(null, 'ws1', {
    apiKey: 'k', apiBase: 'https://us.posthog.com', projectId: '42', now: new Date('2026-10-21T00:41:00Z'),
    request: async () => ({ results: [
      ['sorrel@harborline.example', '$exception', 'TypeError', 'Failed to fetch', '/automations', 2, '2026-10-20T08:00:00Z'],
      ['wren@harborline.example', '$exception', 'TypeError', 'Failed to fetch', '/automations', 1, '2026-10-19T08:00:00Z'],
      ['us@ourco.example', '$exception', 'TypeError', 'Failed to fetch', '/automations', 50, '2026-10-20T08:00:00Z'],
      ['stranger@elsewhere.example', '$exception', 'RangeError', 'Bad', '/x', 50, '2026-10-20T08:00:00Z'],
    ] }),
    skip: (e) => e.endsWith('@ourco.example'),
    companyOf: new Map([['sorrel@harborline.example', 'acct-harbor'], ['wren@harborline.example', 'acct-harbor']]),
    personOf: new Map([['sorrel@harborline.example', 'p-sorrel']]),
    writeInsights: async (_s, ws, items) => { written.push(...items); return items.length; },
  });
  assert.equal(n, 1);
  assert.equal(written[0].company_id, 'acct-harbor');
  assert.equal(written[0].contact_id, 'p-sorrel');
  assert.equal(written[0].kind, 'bug');
  assert.equal(written[0].category, 'product');
  assert.equal(written[0].source_system, 'posthog');
  assert.match(written[0].source_ref, /^source:\/\/posthog\/acct-harbor\/[0-9a-f]{12}\/2026-10-19$/);
  assert.match(written[0].statement, /3 times by 2 people/);
});
