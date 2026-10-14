// Workspace signals (GET-862): a custom signal belongs to the workspace, not a RevBox. Creating
// one needs no box; it gets a stable key (derived, unique, immutable); retiring it archives it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveCustomSignal, archiveCustomSignal, listCustomSignals, reprocessCustomSignal, signalKeyFrom, uniqueSignalKey, SIGNAL_KEY } from '../dist/db/customSignals.mjs';

/** A tiny Supabase stand-in over in-memory tables: select/eq/is/order/limit/single/insert/update. */
function fakeDb(seed = {}) {
  const tables = { workspace_members: [{ workspace_id: 'ws', user_id: 'u1' }, { workspace_id: 'ws', user_id: 'u2' }], custom_signal_definitions: [], revboxes: [], revbox_members: [], ...seed };
  let n = 0;
  return { tables, from(table) {
    const filters = []; let mode = 'select', payload = null, limit = null;
    const run = (single) => {
      const rows = tables[table] ?? (tables[table] = []);
      if (mode === 'insert') {
        if (table === 'custom_signal_definitions' && rows.some(r => r.workspace_id === payload.workspace_id && r.key === payload.key)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        const row = { id: `sig-${++n}`, archived_at: null, created_at: new Date().toISOString(), ...structuredClone(payload) }; rows.push(row);
        return { data: structuredClone(row), error: null };
      }
      let found = rows.filter(r => filters.every(f => f(r)));
      if (mode === 'update') for (const r of found) Object.assign(r, structuredClone(payload));
      if (limit != null) found = found.slice(0, limit);
      if (single === 'single' && !found.length) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      return { data: structuredClone(single ? found[0] ?? null : found), error: null };
    };
    const q = {
      select: () => q, order: () => q, range: () => q,
      limit: (k) => { limit = k; return q; },
      eq: (k, v) => { filters.push(r => r[k] === v); return q; },
      is: (k, v) => { filters.push(r => (r[k] ?? null) === v); return q; },
      insert: (row) => { mode = 'insert'; payload = row; return q; },
      update: (patch) => { mode = 'update'; payload = patch; return q; },
      maybeSingle: () => Promise.resolve(run('maybe')), single: () => Promise.resolve(run('single')),
      then: (resolve, reject) => Promise.resolve(run(false)).then(resolve, reject),
    };
    return q;
  } };
}

test('keys: derived from the name, valid, and unique against every key the workspace used', () => {
  assert.equal(signalKeyFrom('Security review needed!'), 'security_review_needed');
  assert.equal(signalKeyFrom('Café — pricing'), 'cafe_pricing');
  assert.equal(signalKeyFrom('2nd meeting'), 'signal_2nd_meeting');
  assert.equal(signalKeyFrom('!!'), 'signal');
  for (const name of ['Security review needed!', '2nd meeting', 'x', 'a'.repeat(200)]) assert.match(signalKeyFrom(name), SIGNAL_KEY);
  assert.equal(uniqueSignalKey('pricing', []), 'pricing');
  assert.equal(uniqueSignalKey('pricing', ['pricing', 'pricing_2']), 'pricing_3');
  assert.match(uniqueSignalKey('a'.repeat(63), ['a'.repeat(63)]), SIGNAL_KEY);
});

test('creating a signal needs no RevBox; the box it came from is only recorded', async () => {
  const db = fakeDb();
  const s = await saveCustomSignal(db, 'ws', 'u1', { name: 'Security review needed', rule: 'The buyer asks for a security review.', sources: ['Granola', 'gmail'] });
  assert.equal(s.revbox_id, null);
  assert.equal(s.key, 'security_review_needed');
  assert.deepEqual(s.sources, ['granola', 'gmail']);
  assert.equal(s.owner_id, 'u1'); assert.equal(s.version, 1); assert.equal(s.active, false); assert.equal(s.archived, false);
  // A second one with the same name gets the next free key, never the same one.
  const t = await saveCustomSignal(db, 'ws', 'u2', { name: 'Security review needed', rule: 'Again.' });
  assert.equal(t.key, 'security_review_needed_2');
  // An explicit key is validated and must be free.
  await assert.rejects(saveCustomSignal(db, 'ws', 'u1', { name: 'X', rule: 'y', key: 'Bad Key' }), /lowercase/);
  await assert.rejects(saveCustomSignal(db, 'ws', 'u1', { name: 'X', rule: 'y', key: 'security_review_needed' }), e => e.status === 409);
  // A non-member cannot create one.
  await assert.rejects(saveCustomSignal(db, 'ws', 'stranger', { name: 'X', rule: 'y' }), e => e.status === 403);
});

test('the key is immutable; edits are versioned, owner-only and conflict-checked', async () => {
  const db = fakeDb();
  const s = await saveCustomSignal(db, 'ws', 'u1', { name: 'Pricing pushback', rule: 'The buyer pushes back on price.' });
  await assert.rejects(saveCustomSignal(db, 'ws', 'u1', { ...s, key: 'other_key' }, s.id), /cannot change/);
  await assert.rejects(saveCustomSignal(db, 'ws', 'u2', { ...s }, s.id), e => e.status === 403);
  await assert.rejects(saveCustomSignal(db, 'ws', 'u1', { ...s, version: 0 }, s.id), e => e.status === 409);
  const v2 = await saveCustomSignal(db, 'ws', 'u1', { ...s, name: 'Pricing objection', rule: 'Price is too high.', active: true }, s.id);
  assert.equal(v2.key, 'pricing_pushback');   // renaming never renames the key
  assert.equal(v2.version, 2); assert.equal(v2.active, true); assert.equal(v2.versions.length, 2);
  assert.equal(v2.versions.at(-1).reviewed_by, 'u1');
});

test('archiving retires a signal: inactive, not editable, not reprocessable, key never reused', async () => {
  const db = fakeDb();
  const s = await saveCustomSignal(db, 'ws', 'u1', { name: 'Churn talk', rule: 'They mention leaving.', active: true });
  await assert.rejects(archiveCustomSignal(db, 'ws', 'u2', s.id), e => e.status === 403);
  const a = await archiveCustomSignal(db, 'ws', 'u1', s.id);
  assert.equal(a.active, false); assert.ok(a.archived_at); assert.equal(a.archived, true); assert.equal(a.version, 2);
  await assert.rejects(saveCustomSignal(db, 'ws', 'u1', { ...a, active: true }, s.id), /archived/);
  await assert.rejects(reprocessCustomSignal(db, 'ws', 'u1', s.id, new Date().toISOString()), /archived/);
  const again = await saveCustomSignal(db, 'ws', 'u1', { name: 'Churn talk', rule: 'New meaning.' });
  assert.equal(again.key, 'churn_talk_2');
  const list = await listCustomSignals(db, 'ws', 'u1');
  assert.deepEqual(list.map(r => [r.key, r.archived]).sort(), [['churn_talk', true], ['churn_talk_2', false]]);
  // Archiving twice is a no-op, not an error.
  assert.equal((await archiveCustomSignal(db, 'ws', 'u1', s.id)).version, 2);
});
