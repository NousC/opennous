// The read ledger carries the API key that caused a read (API plan E6, GET-620).
//
// A credit is spent when Nous reads a conversation, which happens here, in the worker, after the
// API request that wrote the claim citing it. The claim carries metadata.api_key_id when a key
// wrote it (recordObservations); the ledger copies it onto the read it bills, and writes an
// explicit null otherwise, so a read from now on is told apart from one written before the stamp.
//
// Run: cd apps/worker && node --test tests/readLedgerKey.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readValue, sweepWorkspace } from '../src/workers/readLedger.mjs';

const WS = 'ws-1';
const AT = '2026-10-03T10:00:00.000Z';

test('readValue: the key that wrote the citing claim, or null', () => {
  const bill = { kind: 'call', system: 'ringcentral', credits: 1 };
  assert.equal(readValue({ ref: 'source://ringcentral/c1', valid_from: AT, meta: { api_key_id: 'k1' } }, bill).api_key_id, 'k1');
  for (const meta of [{}, null, undefined, { api_key_id: '' }, { api_key_id: 42 }]) {
    const v = readValue({ ref: 'source://ringcentral/c1', valid_from: AT, meta }, bill);
    assert.ok(Object.prototype.hasOwnProperty.call(v, 'api_key_id'), 'always present, so "no key" is not "unknown"');
    assert.equal(v.api_key_id, null);
  }
  assert.deepEqual(readValue({ ref: 'source://fellow/n1', valid_from: AT, meta: {} }, { kind: 'meeting', credits: 4, minutes: 37 }),
    { source_ref: 'source://fellow/n1', kind: 'meeting', credits: 4, read_at: AT, minutes: 37, api_key_id: null });
});

// A fake that answers the sweep's claims page and records what the ledger inserts.
function fakeSupabase(claims) {
  const inserted = [];
  const gteCols = [];
  const builder = (table) => {
    const q = { table, insert: null };
    const b = new Proxy({}, {
      get(_t, op) {
        if (op === 'then') {
          let res = { data: [], error: null };
          if (q.table === 'claims') res = { data: claims, error: null };
          if (q.table === 'observations' && q.insert) {
            inserted.push(q.insert);
            res = { data: { id: `o${inserted.length}`, ...q.insert }, error: null };
          }
          return (ok, ko) => Promise.resolve(res).then(ok, ko);
        }
        if (op === 'insert') return (row) => { q.insert = row; return b; };
        if (op === 'gte') return (col) => { if (q.table === 'claims') gteCols.push(col); return b; };
        return () => b;
      },
    });
    return b;
  };
  return { inserted, gteCols, from: builder, rpc: () => Promise.resolve({ data: null, error: null }) };
}

test('sweep: a call cited first by a key-written claim is billed to that key; an integration\'s to none', async () => {
  const sb = fakeSupabase([
    { entity_id: 'e1', valid_from: AT, ref: 'source://ringcentral/c1', meta: { api_key_id: 'k1', source_ref: 'source://ringcentral/c1' } },
    // The same call cited again by an integration later: one read per conversation, the first one's.
    { entity_id: 'e1', valid_from: AT, ref: 'source://ringcentral/c1', meta: { source_ref: 'source://ringcentral/c1' } },
    { entity_id: 'e2', valid_from: AT, ref: 'source://justcall/c2', meta: { source_ref: 'source://justcall/c2' } },
    // Email is the reader's own ledger, never this one.
    { entity_id: 'e3', valid_from: AT, ref: 'source://gmail/t1', meta: { api_key_id: 'k1' } },
  ]);
  const n = await sweepWorkspace(sb, WS, { since: '2026-10-01T00:00:00.000Z' });
  assert.equal(n, 2);
  const reads = sb.inserted.filter((r) => r.property === 'noema.read');
  assert.deepEqual(reads.map((r) => [r.external_id, r.value.api_key_id, r.value.credits]), [
    ['read_source://ringcentral/c1', 'k1', 1],
    ['read_source://justcall/c2', null, 1],
  ]);
});

// GET-770 dates a claim by when its source was SAID. The ledger's watermark is the last read it
// billed, so selecting claims by valid_from would never bill a backfill, a Gmail thread read a
// day late, or a transcript that lands after a newer call: their claims are dated before it.
test('sweep: claims are picked up by when they were WRITTEN, never by when the source said them', async () => {
  const sb = fakeSupabase([{ entity_id: 'e2', valid_from: AT, ref: 'source://justcall/c2', meta: { source_ref: 'source://justcall/c2' } }]);
  await sweepWorkspace(sb, WS, { since: '2026-10-01T00:00:00.000Z' });
  assert.deepEqual(sb.gteCols, ['computed_at']);
});
