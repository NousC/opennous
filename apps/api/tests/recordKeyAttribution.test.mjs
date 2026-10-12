// A claim written through an API key carries the key (API plan E6, GET-620).
//
// Credits are spent later, in the worker, when the read ledger first sees a claim cite a meeting
// or call. The key has to be on the claim for the ledger to bill the read to it. The in-app agent
// and session calls use the same recordObservations with no key, and stamp nothing.
//
// Run: cd apps/api && node --test tests/recordKeyAttribution.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.OPENAI_API_KEY; // saveNote's embed is best-effort; keep it offline
const { recordObservations } = await import('../src/lib/recordObservations.mjs');

const WS = '11111111-1111-4111-8111-111111111111';
const ENTITY = '22222222-2222-4222-8222-222222222222';

function fakeSupabase() {
  const claims = [];
  const from = (table) => {
    const q = { table, insert: null };
    const b = new Proxy({}, {
      get(_t, op) {
        if (op === 'then') {
          let res = { data: [], error: null };
          if (q.table === 'claims' && q.insert) {
            claims.push(q.insert);
            res = { data: { id: `c${claims.length}`, ...q.insert }, error: null };
          }
          return (ok, ko) => Promise.resolve(res).then(ok, ko);
        }
        if (op === 'insert') return (row) => { q.insert = row; return b; };
        return () => b;
      },
    });
    return b;
  };
  return { claims, from, rpc: () => Promise.resolve({ data: null, error: null }) };
}

const body = {
  focus: ENTITY,
  observations: [{
    kind: 'state', property: 'intel', source: 'fireflies', source_ref: 'source://fireflies/m1',
    value: { category: 'pain', content: 'Reconciling payouts by hand every Friday.', about: 'person' },
  }],
};

test('a write through a key stamps the key on the claim, beside the conversation it cites', async () => {
  const sb = fakeSupabase();
  const out = await recordObservations(sb, WS, body, { apiKeyId: 'key-1' });
  assert.equal(out.ok, true);
  assert.equal(out.recorded, 1);
  assert.equal(sb.claims.length, 1);
  const meta = sb.claims[0].value.metadata;
  assert.equal(meta.api_key_id, 'key-1');
  assert.equal(meta.source_ref, 'source://fireflies/m1');
});

test('the same write with no key (the in-app agent, a session) stamps nothing', async () => {
  for (const opts of [{}, { apiKeyId: null }, { userId: 'u1' }]) {
    const sb = fakeSupabase();
    await recordObservations(sb, WS, body, opts);
    assert.equal(sb.claims.length, 1);
    assert.ok(!('api_key_id' in sb.claims[0].value.metadata), JSON.stringify(opts));
  }
});
