import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceKeyFor, lastSyncedByConnection } from '../src/providers/lastSynced.mjs';

// The source cards' "Synced Xm ago" (GET-631). What must hold: the time comes from data that
// actually arrived, a personal source never borrows a teammate's sync, and a slow or failing
// lookup is a blank label rather than a broken page.

// A tiny stand-in for the PostgREST builder: records filters, answers from fixtures.
function fakeSupabase({ observations = [], crm = [], failObs = false, hang = false } = {}) {
  const calls = [];
  const from = (table) => {
    const f = { table, eq: {}, in: null };
    const b = {
      select() { return b; },
      eq(col, v) { f.eq[col] = v; return b; },
      in(col, vs) { f.in = [col, vs]; return b; },
      order() { return b; },
      limit() { return b; },
      then(resolve, reject) {
        calls.push(f);
        if (hang) return new Promise(() => {}).then(resolve, reject);
        if (table === 'observations') {
          if (failObs) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve, reject);
          const rows = observations
            .filter((o) => Object.entries(f.eq).every(([k, v]) => o[k] === v))
            .sort((a, b) => Date.parse(b.ingested_at) - Date.parse(a.ingested_at));
          return Promise.resolve({ data: rows.slice(0, 1), error: null }).then(resolve, reject);
        }
        if (table === 'crm_sync_configs') {
          const rows = crm.filter((r) => f.in[1].includes(r.connection_id));
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: [], error: null }).then(resolve, reject);
      },
    };
    return b;
  };
  return { from, calls };
}

const WS = 'ws1';

test('provider slugs map to observation sources', () => {
  assert.equal(sourceKeyFor('gmail_oauth'), 'gmail');
  assert.equal(sourceKeyFor('Fireflies'), 'fireflies');
  assert.equal(sourceKeyFor(''), null);
  assert.equal(sourceKeyFor(null), null);
});

test('a personal source reads only its owner\'s observations', async () => {
  const sb = fakeSupabase({ observations: [
    { workspace_id: WS, source: 'gmail', owner_user_id: 'me', ingested_at: '2026-10-01T10:00:00Z' },
    { workspace_id: WS, source: 'gmail', owner_user_id: 'teammate', ingested_at: '2026-10-03T10:00:00Z' },
  ] });
  const out = await lastSyncedByConnection(sb, WS, [
    { id: 'c1', scope: 'personal', owner_user_id: 'me', provider: { name: 'gmail_oauth' } },
  ]);
  assert.equal(out.get('c1'), '2026-10-01T10:00:00Z');
});

test('a company source reads everyone\'s, and a CRM takes the later of its sync and its data', async () => {
  const sb = fakeSupabase({
    observations: [{ workspace_id: WS, source: 'hubspot', owner_user_id: 'x', ingested_at: '2026-10-01T00:00:00Z' }],
    crm: [{ connection_id: 'c2', last_synced_at: '2026-10-02T00:00:00Z' }],
  });
  const out = await lastSyncedByConnection(sb, WS, [
    { id: 'c2', scope: 'company', owner_user_id: 'me', provider: { name: 'hubspot' } },
  ]);
  assert.equal(out.get('c2'), '2026-10-02T00:00:00Z');
});

test('two connections of one tool share one lookup (its source and source_live)', async () => {
  const sb = fakeSupabase({ observations: [{ workspace_id: WS, source: 'instantly', ingested_at: '2026-10-01T00:00:00Z' }] });
  await lastSyncedByConnection(sb, WS, [
    { id: 'a', scope: 'company', provider: { name: 'instantly' } },
    { id: 'b', scope: 'company', provider: { name: 'instantly' } },
  ]);
  const obs = sb.calls.filter((c) => c.table === 'observations');
  assert.deepEqual(obs.map((c) => c.eq.source).sort(), ['instantly', 'instantly_live']);
});

test('data that arrived live (source <slug>_live) counts', async () => {
  const sb = fakeSupabase({ observations: [
    { workspace_id: WS, source: 'smartlead', ingested_at: '2026-10-01T00:00:00Z' },
    { workspace_id: WS, source: 'smartlead_live', ingested_at: '2026-10-03T08:00:00Z' },
  ] });
  const out = await lastSyncedByConnection(sb, WS, [{ id: 'a', scope: 'company', provider: { name: 'smartlead' } }]);
  assert.equal(out.get('a'), '2026-10-03T08:00:00Z');
});

test('the CRM and observation lookups run in parallel: a hang costs one deadline, not two', async () => {
  const started = Date.now();
  const out = await lastSyncedByConnection(fakeSupabase({ hang: true }), WS,
    [{ id: 'a', scope: 'company', provider: { name: 'hubspot' } }], { deadlineMs: 150 });
  const took = Date.now() - started;
  assert.equal(out.get('a'), null);
  assert.ok(took < 280, `took ${took}ms`);
});

test('nothing arrived, an error, or a hang: null, never a throw', async () => {
  const none = await lastSyncedByConnection(fakeSupabase(), WS, [{ id: 'a', scope: 'company', provider: { name: 'apollo' } }]);
  assert.equal(none.get('a'), null);
  const failed = await lastSyncedByConnection(fakeSupabase({ failObs: true }), WS, [{ id: 'a', scope: 'company', provider: { name: 'apollo' } }]);
  assert.equal(failed.get('a'), null);
  const hung = await lastSyncedByConnection(fakeSupabase({ hang: true }), WS, [{ id: 'a', scope: 'company', provider: { name: 'apollo' } }], { deadlineMs: 20 });
  assert.equal(hung.get('a'), null);
});
