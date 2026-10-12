// Stated preferences, and the routing that decides where a correction lands.
//
// The tests here are about two failures. Sending a correction to the wrong home, which is the
// quiet one — a structural request stored as a prompt rule gets dropped, a prohibition stored
// as a preference gets weighed and overridden. And over-capture, which is the loud one: most
// edits are a typo, and treating those as preferences fills the context with noise that crowds
// out the real signal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPreference, listPreferences, renderPreferences } from '../dist/db/preferences.mjs';

const db = (rows = [], prior = null) => {
  const writes = [];
  return {
    writes,
    from() {
      const c = {};
      for (const m of ['select', 'eq', 'is', 'order', 'update']) c[m] = () => c;
      c.maybeSingle = () => Promise.resolve({ data: c._row ?? prior });
      c.upsert = (row) => { writes.push(row); c._row = row; return c; };
      c.single = () => Promise.resolve({ data: c._row });
      c.then = (res) => res({ data: rows, error: null });
      return c;
    },
  };
};

test('a person preference with no owner is refused, not made everyone’s', async () => {
  await assert.rejects(
    () => addPreference(db(), 'ws-1', { statement: 'write shorter', scope: 'person' }),
    /user_id_required_for_person_scope/,
  );
});

test('repeating yourself strengthens the preference rather than duplicating it', async () => {
  // Three separate edits pointing the same way is a materially stronger signal than one
  // offhand remark, and the difference is worth keeping.
  const d = db([], { id: 'p1', observed_count: 2, evidence_ids: ['d1', 'd2'] });
  await addPreference(d, 'ws-1', {
    statement: 'write shorter', scope: 'person', user_id: 'u-1', evidence_ids: ['d3'],
  });
  assert.equal(d.writes[0].observed_count, 3);
  assert.deepEqual(d.writes[0].evidence_ids, ['d1', 'd2', 'd3']);
});

test('re-stating a lifted preference brings it back', async () => {
  // They changed their mind. Holding the old removal against them would be the system arguing
  // with its user.
  const d = db([], { id: 'p1', observed_count: 1, evidence_ids: [] });
  await addPreference(d, 'ws-1', { statement: 'write shorter', scope: 'person', user_id: 'u-1' });
  assert.equal(d.writes[0].removed_at, null);
});

test('an unnarrowed preference governs everything', async () => {
  // Someone who said "write shorter" without qualifying it meant it. Dropping it because the
  // caller passed a type would be us deciding we knew better.
  const rows = [
    { id: 'a', scope: 'person', user_id: 'u-1', statement: 'write shorter', applies_to: null },
    { id: 'b', scope: 'person', user_id: 'u-1', statement: 'lead with the number', applies_to: 'report' },
  ];
  const forEmail = await listPreferences(db(rows), 'ws-1', { userId: 'u-1', appliesTo: 'email_send' });
  assert.deepEqual(forEmail.map((p) => p.id), ['a']);
  const forReport = await listPreferences(db(rows), 'ws-1', { userId: 'u-1', appliesTo: 'report' });
  assert.deepEqual(forReport.map((p) => p.id), ['a', 'b']);
});

test('a colleague does not inherit a personal preference', async () => {
  const rows = [
    { id: 'a', scope: 'person', user_id: 'u-1', statement: 'write shorter' },
    { id: 'b', scope: 'workspace', user_id: null, statement: 'always name the next step' },
  ];
  const theirs = await listPreferences(db(rows), 'ws-1', { userId: 'u-2' });
  assert.deepEqual(theirs.map((p) => p.id), ['b']);
});

test('preferences render softer than a constraint, and show when one is well-established', () => {
  const text = renderPreferences([
    { statement: 'write shorter', observed_count: 4, applies_to: null },
    { statement: 'lead with the number', observed_count: 1, applies_to: 'report' },
  ]);
  assert.match(text, /HOW THIS OPERATOR WANTS THINGS/);
  // A preference is about shape, not prohibition. An agent treating "write shorter" as
  // inviolable produces something useless when the situation genuinely needs length.
  assert.match(text, /unless the situation/);
  assert.match(text, /4×/);
  assert.match(text, /\[report\]/);
});

test('nothing renders empty, so callers can concatenate blindly', () => {
  assert.equal(renderPreferences([]), '');
  assert.equal(renderPreferences(null), '');
});
