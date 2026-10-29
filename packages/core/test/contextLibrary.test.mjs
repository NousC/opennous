// The context library in the open-source build (2026-10-29): no RevBoxes are registered, so no file
// is ever tagged and a 'boxes' file is its creator's alone. Its own process, so the Cloud layer's
// registration (test/cloud/contextLibrary.test.mjs) never reaches it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listContextLibrary, createContextFile, updateContextFile, deleteContextFile, loadContextFile, listContextVersions, restoreContextVersion,
} from '../dist/context/library.mjs';

const WS = 'ws-1';
function database() {
  const tables = {
    workspace_members: [{ workspace_id: WS, user_id: 'owner', role: 'owner' }, { workspace_id: WS, user_id: 'member', role: 'member' }],
    workspace_context_files: [], workspace_context_file_versions: [], users: [{ id: 'owner', name: 'Dana Whitfield' }], documents: [],
  };
  let seq = 0;
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select() { return this; } order() { return this; } limit() { return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    in(k, vs) { this.filters.push(r => vs.includes(r[k])); return this; }
    insert(v) { this.op = 'insert'; this.value = v; return this; }
    update(v) { this.op = 'update'; this.value = v; return this; }
    delete() { this.op = 'delete'; return this; }
    run(single) {
      if (this.table === 'revbox_context_links' || this.table === 'revboxes') throw new Error(`the open-source build read ${this.table}`);
      const all = (tables[this.table] ??= []);
      let values = all.filter(r => this.filters.every(f => f(r)));
      if (this.op === 'insert') { const row = { id: `${this.table}-${++seq}`, created_at: `t${String(seq).padStart(3, '0')}`, updated_at: `t${String(seq).padStart(3, '0')}`, ...this.value }; all.push(row); values = [row]; }
      if (this.op === 'update') for (const r of values) Object.assign(r, this.value);
      if (this.op === 'delete') tables[this.table] = all.filter(r => !values.includes(r));
      return { data: structuredClone(single ? values[0] ?? null : values), error: null };
    }
    maybeSingle() { return Promise.resolve(this.run(true)); } single() { return this.maybeSingle(); }
    then(res, rej) { return Promise.resolve(this.run(false)).then(res, rej); }
  }
  return { tables, from: t => new Query(t) };
}

test('open source: a private file is its creator\'s, a shared one everyone\'s; no box is ever read', async () => {
  const sb = database();
  const mine = await createContextFile(sb, WS, 'owner', { title: 'Pricing notes', body: 'Seats are never metered.' });
  const shared = await createContextFile(sb, WS, 'owner', { title: 'Voice', body: 'Short sentences.', visibility: 'workspace' });
  assert.deepEqual(mine.boxes, []); assert.equal(mine.hidden_boxes, 0); assert.equal(mine.can_edit, true);
  assert.deepEqual((await listContextLibrary(sb, WS, 'owner')).files.map(f => f.title).sort(), ['Pricing notes', 'Voice']);
  const member = await listContextLibrary(sb, WS, 'member');
  assert.deepEqual(member.files.map(f => f.id), [shared.id]);
  assert.deepEqual(member.boxes, []);
  await assert.rejects(loadContextFile(sb, WS, 'member', mine.id), e => e.status === 404);
});

test('open source: there is no RevBox to tag a file to', async () => {
  const sb = database();
  await assert.rejects(createContextFile(sb, WS, 'owner', { title: 'Plan', body: 'x', revbox_ids: ['box-1'] }), e => e.status === 404 && /RevBox not found/.test(e.message));
  assert.equal(sb.tables.workspace_context_files.length, 0);
  const file = await createContextFile(sb, WS, 'owner', { title: 'Plan', body: 'x' });
  await assert.rejects(updateContextFile(sb, WS, 'owner', file.id, { revbox_ids: ['box-1'] }), e => e.status === 404);
  assert.deepEqual((await updateContextFile(sb, WS, 'owner', file.id, { revbox_ids: [] })).boxes, []);
});

test('open source: versions, restore and delete work without RevBoxes', async () => {
  const sb = database();
  const file = await createContextFile(sb, WS, 'owner', { title: 'ICP draft', body: 'v1', visibility: 'workspace' });
  await updateContextFile(sb, WS, 'owner', file.id, { body: 'v2' });
  const versions = await listContextVersions(sb, WS, 'owner', file.id);
  assert.equal(versions.length, 2);
  const first = versions.find(v => v.body === 'v1');
  assert.equal((await restoreContextVersion(sb, WS, 'owner', file.id, first.id)).body, 'v1');
  await deleteContextFile(sb, WS, 'owner', file.id);
  assert.equal(sb.tables.workspace_context_files.length, 0);
  assert.equal(sb.tables.workspace_context_file_versions.at(-1).changelog, 'Deleted');
});

test('open source: the About us file is one, shared, an admin\'s to choose', async () => {
  const sb = database();
  await assert.rejects(createContextFile(sb, WS, 'member', { title: 'About us', body: 'We sell Lumen.', kind: 'about' }), e => e.status === 403);
  const about = await createContextFile(sb, WS, 'owner', { title: 'About us', body: 'We sell Lumen.', kind: 'about' });
  assert.equal(about.kind, 'about'); assert.equal(about.visibility, 'workspace');
});
