// Credits per API key (API plan E6, GET-620): the read ledger's reads summed per key. A read
// stamped with a key is that key's; stamped null is something else's (an integration, the app);
// a read with no stamp at all predates the stamping and its cause is unknown.
//
// Run: cd packages/core && npm run build && node --test test/creditsByKey.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditsByKeyFromReads, conversationCreditsByKey, conversationCredits, readRowCredits, CREDIT_SCALE } from '../dist/db/conversationCredits.js';

test('Slack conversations count once at the normal scale and are not labelled as meetings', async () => {
  const db = { from(table) {
    const q = { then: resolve => Promise.resolve({ data: table === 'observations'
      ? [{ source: 'slack', observed_at: '2026-10-20T12:00:00Z', value: { kind: 'message', credits: 1 } }] : [], error: null }).then(resolve) };
    for (const method of ['select', 'eq', 'gte', 'in', 'order', 'range']) q[method] = () => q;
    return q;
  } };
  const out = await conversationCredits(db, ['workspace'], '2026-10-01');
  assert.equal(out.messages, CREDIT_SCALE);
  assert.equal(out.meetings, 0);
  assert.equal(out.total, CREDIT_SCALE);
});

const read = (source, value) => ({ source, value });

test('a read counts at the billing scale: a call 1, a meeting its stored credits, email 1', () => {
  assert.equal(readRowCredits(read('ringcentral', { kind: 'call', credits: 1 })), CREDIT_SCALE);
  assert.equal(readRowCredits(read('fellow', { kind: 'meeting', credits: 3 })), 3 * CREDIT_SCALE);
  assert.equal(readRowCredits(read('gmail', null)), CREDIT_SCALE);
});

test('reads sum per key; null-stamped reads go to no key; unstamped reads are unknown', () => {
  const out = creditsByKeyFromReads([
    read('fireflies', { kind: 'meeting', credits: 3, api_key_id: 'k1' }),
    read('ringcentral', { kind: 'call', credits: 1, api_key_id: 'k1' }),
    read('fellow', { kind: 'meeting', credits: 2, api_key_id: 'k2' }),
    read('fireflies', { kind: 'meeting', credits: 3, api_key_id: null }),     // the Fireflies integration
    read('hubspot', { kind: 'meeting', credits: 3 }),                         // before stamping
  ]);
  assert.deepEqual([...out.byKey], [['k1', 4 * CREDIT_SCALE], ['k2', 2 * CREDIT_SCALE]]);
  assert.equal(out.unattributed, 3 * CREDIT_SCALE);
  assert.equal(out.unknown, 3 * CREDIT_SCALE);
});

test('email is never a key, even if a value says otherwise', () => {
  const out = creditsByKeyFromReads([read('gmail', { api_key_id: 'k1' })]);
  assert.equal(out.byKey.size, 0);
  assert.equal(out.unattributed, CREDIT_SCALE);
  assert.equal(out.unknown, 0);
});

test('a zero-credit read and an empty key id count for nobody', () => {
  const out = creditsByKeyFromReads([
    read('fellow', { credits: 0, api_key_id: 'k1' }),
    read('fellow', { credits: 1, api_key_id: '' }),
  ]);
  assert.equal(out.byKey.size, 0);
  assert.equal(out.unattributed, CREDIT_SCALE);
});

function fakeSupabase(pages) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = { table, ops: [] };
      calls.push(q);
      const b = new Proxy({}, {
        get(_t, op) {
          if (op === 'then') {
            const range = q.ops.find(([o]) => o === 'range');
            const page = pages[Math.floor((range?.[1] ?? 0) / 1000)] ?? [];
            const res = page instanceof Error ? { data: null, error: page } : { data: page, error: null };
            return (ok, ko) => Promise.resolve(res).then(ok, ko);
          }
          return (...args) => { q.ops.push([op, ...args]); return b; };
        },
      });
      return b;
    },
  };
}

test('the query: one workspace, the read ledger, no email, from the window start', async () => {
  const sb = fakeSupabase([[read('fellow', { credits: 2, api_key_id: 'k1' })]]);
  const out = await conversationCreditsByKey(sb, 'ws-1', '2026-09-04T00:00:00.000Z');
  assert.equal(out.byKey.get('k1'), 2 * CREDIT_SCALE);
  const ops = sb.calls[0].ops;
  assert.equal(sb.calls[0].table, 'observations');
  for (const want of [['eq', 'workspace_id', 'ws-1'], ['eq', 'property', 'noema.read'], ['neq', 'source', 'gmail'], ['gte', 'observed_at', '2026-09-04T00:00:00.000Z']]) {
    assert.ok(ops.some((o) => JSON.stringify(o) === JSON.stringify(want)), `missing ${want.join(' ')}`);
  }
});

test('the query pages past 1000 rows rather than stopping at the PostgREST cap', async () => {
  const full = Array.from({ length: 1000 }, () => read('ringcentral', { credits: 1, api_key_id: 'k1' }));
  const out = await conversationCreditsByKey(fakeSupabase([full, [read('ringcentral', { credits: 1, api_key_id: 'k1' })]]), 'ws-1', '2026-09-04T00:00:00.000Z');
  assert.equal(out.byKey.get('k1'), 1001 * CREDIT_SCALE);
});

test('a failed read throws, never a quiet zero', async () => {
  await assert.rejects(conversationCreditsByKey(fakeSupabase([new Error('statement timeout')]), 'ws-1', '2026-09-04T00:00:00.000Z'), /statement timeout/);
});
