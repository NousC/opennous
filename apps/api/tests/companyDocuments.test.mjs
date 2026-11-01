// Documents (GET-1117): operators push a document in and choose who sees it; people and agents read
// what they may. Nothing here touches a repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { contextFileVisible, contextFileEditable, readableContextFiles, pushDocument, updateContextFile, createContextFile, listContextVersions, listContextLibrary, loadContextFile } = await import('@nous/core');

// A small PostgREST-like fake: eq / not-is-null / like filters, insert, update, select, single.
function db(seed) {
  const tables = { workspace_context_file_versions: [], users: [{ id: 'u1', name: 'Olive Owner', email: 'olive@acme.example' }], ...structuredClone(seed) };
  class Q {
    constructor(t) { this.t = t; this.f = []; }
    select() { return this; } order() { return this; } limit() { return this; }
    eq(k, v) { this.f.push(r => r[k] === v); return this; }
    in(k, vs) { this.f.push(r => vs.includes(r[k])); return this; }
    is(k, v) { this.f.push(r => (r[k] ?? null) === v); return this; }
    not(k, _op, v) { this.f.push(r => (r[k] ?? null) !== v); return this; }
    like(k, p) { const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`); this.f.push(r => re.test(r[k] ?? '')); return this; }
    insert(v) { this.op = 'insert'; this.v = v; return this; }
    update(v) { this.op = 'update'; this.v = v; return this; }
    upsert(v) { this.op = 'upsert'; this.v = v; return this; }
    delete() { this.op = 'delete'; return this; }
    run(one) {
      const all = (tables[this.t] ??= []);
      let rows = all.filter(r => this.f.every(f => f(r)));
      if (this.op === 'insert') { const r = { id: `${this.t}-${all.length + 1}`, created_at: new Date().toISOString(), ...this.v }; all.push(r); rows = [r]; }
      if (this.op === 'update') rows.forEach(r => Object.assign(r, this.v));
      return { data: structuredClone(one ? rows[0] ?? null : rows), error: null };
    }
    maybeSingle() { return Promise.resolve(this.run(true)); } single() { return this.maybeSingle(); }
    then(a, b) { return Promise.resolve(this.run(false)).then(a, b); }
  }
  return { tables, from: t => new Q(t) };
}


const WS = 'ws1';
const seats = [{ workspace_id: WS, user_id: 'op', role: 'admin' }, { workspace_id: WS, user_id: 'owner', role: 'owner' }, { workspace_id: WS, user_id: 'rep', role: 'member' }];
const base = () => db({ workspace_context_files: [], workspace_members: structuredClone(seats) });

test('an operators file is for owners and admins, even its creator if they are a member', () => {
  const f = { visibility: 'operators', created_by: 'rep' }, none = new Set();
  assert.equal(contextFileVisible(f, 'rep', none, [], 'member'), false);
  assert.equal(contextFileVisible(f, 'op', none, [], 'admin'), true);
  assert.equal(contextFileVisible(f, 'owner', none, [], 'owner'), true);
  assert.equal(contextFileVisible(f, 'op', none, []), false, 'no role reads as no');
  assert.equal(contextFileEditable(f, 'rep', 'member', new Map(), []), false);
  assert.equal(contextFileEditable(f, 'op', 'admin', new Map(), []), true);
});

test('an operator pushes a document, operators-only until they say otherwise', async () => {
  const sb = base();
  const { file, created } = await pushDocument(sb, WS, 'op', { title: 'Q1 push', folder: 'Initiatives', body: '# Q1' });
  assert.equal(created, true);
  assert.equal(file.visibility, 'operators');
  assert.equal(file.folder, 'Initiatives');
  await assert.rejects(loadContextFile(sb, WS, 'rep', file.id), /not found/);
  assert.equal((await listContextLibrary(sb, WS, 'rep')).files.length, 0);
  assert.equal((await listContextLibrary(sb, WS, 'owner')).files.length, 1);
});

test('pushing the same title in the same folder is the next version, and keeps who it is shared with', async () => {
  const sb = base();
  const first = await pushDocument(sb, WS, 'op', { title: 'Objections', folder: 'Playbook', body: 'v1', visibility: 'workspace' });
  const again = await pushDocument(sb, WS, 'op', { title: 'Objections', folder: 'Playbook', body: 'v2' });
  assert.equal(again.created, false);
  assert.equal(again.file.id, first.file.id);
  assert.equal(again.file.visibility, 'workspace');
  assert.equal(sb.tables.workspace_context_files.length, 1);
  assert.equal(sb.tables.workspace_context_file_versions.length, 2);
  const other = await pushDocument(sb, WS, 'op', { title: 'Objections', folder: 'Archive', body: 'v1' });
  assert.equal(other.created, true);
});

test('a member cannot push, share with operators, or change an operators file', async () => {
  const sb = base();
  await assert.rejects(pushDocument(sb, WS, 'rep', { title: 'x', folder: 'Strategy', body: 'y' }), /owner or admin/);
  await assert.rejects(createContextFile(sb, WS, 'rep', { title: 'x', body: 'y', visibility: 'operators' }), /owner or admin/);
  const { file } = await pushDocument(sb, WS, 'op', { title: 'S', folder: 'Strategy', body: 'y' });
  await assert.rejects(updateContextFile(sb, WS, 'rep', file.id, { body: 'mine' }), /not found/);
  await assert.rejects(pushDocument(sb, WS, 'stranger', { title: 'x', folder: 'S', body: 'y' }), /not a member/);
});

test('a push needs a folder and text', async () => {
  const sb = base();
  await assert.rejects(pushDocument(sb, WS, 'op', { title: 'x', body: 'y' }), /folder/);
  await assert.rejects(pushDocument(sb, WS, 'op', { title: 'x', folder: 'S', body: '  ' }), /text/);
});

test('an operator can open a document up, and close it again', async () => {
  const sb = base();
  const { file } = await pushDocument(sb, WS, 'op', { title: 'S', folder: 'Strategy', body: 'y' });
  await updateContextFile(sb, WS, 'op', file.id, { visibility: 'workspace' });
  assert.equal((await listContextLibrary(sb, WS, 'rep')).files.length, 1);
  await updateContextFile(sb, WS, 'op', file.id, { visibility: 'operators' });
  assert.equal((await listContextLibrary(sb, WS, 'rep')).files.length, 0);
});

test('what an agent reads depends on the person behind the key', async () => {
  const sb = db({ workspace_context_files: [
    { id: 'ops', workspace_id: WS, visibility: 'operators', created_by: 'rep', updated_at: '1' },
    { id: 'team', workspace_id: WS, visibility: 'workspace', created_by: 'op', updated_at: '2' },
    { id: 'mine', workspace_id: WS, visibility: 'boxes', created_by: 'rep', updated_at: '3' },
    { id: 'link', workspace_id: WS, visibility: 'workspace', document_id: 'd1', created_by: 'op', updated_at: '4' },
  ] });
  const ids = async (who) => (await readableContextFiles(sb, WS, who)).map(f => f.id).sort();
  assert.deepEqual(await ids({ userId: 'op', admin: true }), ['ops', 'team']);
  assert.deepEqual(await ids({ userId: 'rep', admin: false }), ['mine', 'team']);
  assert.deepEqual(await ids({ userId: null, admin: true }), ['team'], 'a workspace key is no operator');
  assert.deepEqual(await ids({}), ['team']);
});

test('the push route refuses anyone who is not an operator with their own key', async () => {
  process.env.SUPABASE_URL ??= 'http://fake-supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-role-test';
  const { default: express } = await import('express');
  const { companyDocumentsV2Router } = await import('../src/routes/v2/companyDocuments.mjs');
  const { NO_CONTENT_VIEWER } = await import('@nous/core');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, JSON.parse(req.get('x-who'))); next(); });
  app.use('/', companyDocumentsV2Router);
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const push = (who, extra = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-who': JSON.stringify({ workspaceId: WS, ...who }) }, body: JSON.stringify({ title: 't', folder: 'f', markdown: 'm', ...extra }) });
  try {
    assert.equal((await push({ viewerScope: 'member', memberUserId: 'rep' })).status, 403);
    assert.equal((await push({ viewerScope: 'admin', memberUserId: null, noContent: true })).status, 403, 'a workspace key');
    assert.equal((await push({ viewerScope: 'admin', memberUserId: NO_CONTENT_VIEWER })).status, 403, 'a read-only workspace key');
    assert.equal((await push({ viewerScope: 'admin', memberUserId: 'op' }, { shared_with: 'the world' })).status, 400);
    assert.equal((await push({ viewerScope: 'admin', memberUserId: 'op' }, { folder: 'a/b' })).status, 400);
  } finally { server.closeAllConnections?.(); server.close(); }
});

test('a document stays in its folder, and only operators change who sees it', async () => {
  const sb = base();
  const { file } = await pushDocument(sb, WS, 'op', { title: 'S', folder: 'Strategy', body: 'y', visibility: 'workspace' });
  await assert.rejects(updateContextFile(sb, WS, 'rep', file.id, { folder: null }), /stays in its folder/);
  await assert.rejects(updateContextFile(sb, WS, 'op', file.id, { folder: 'Other' }), /stays in its folder/);
  assert.equal(sb.tables.workspace_context_files[0].folder, 'Strategy');
});

test('someone else\'s private file under the same name is left alone, and stays unconfirmed', async () => {
  const sb = base();
  sb.tables.workspace_context_files.push({ id: 'private', workspace_id: WS, title: 'S', folder: 'Strategy', body: 'hers', visibility: 'boxes', created_by: 'owner', updated_at: '1' });
  const { created, file } = await pushDocument(sb, WS, 'op', { title: 'S', folder: 'Strategy', body: 'mine' });
  assert.equal(created, true);
  assert.notEqual(file.id, 'private');
  assert.equal(sb.tables.workspace_context_files.find(f => f.id === 'private').body, 'hers');
});

test('nobody makes a colleague\'s pushed document private', async () => {
  const sb = base();
  await pushDocument(sb, WS, 'owner', { title: 'S', folder: 'Strategy', body: 'v1', visibility: 'workspace' });
  await assert.rejects(pushDocument(sb, WS, 'op', { title: 'S', folder: 'Strategy', body: 'v2', visibility: 'boxes' }), /Only the person/);
});

test('an Intelligence file cannot be closed to operators, and a marked file stays shared', async () => {
  const sb = base();
  sb.tables.workspace_living_files = [{ workspace_id: WS, key: 'win_loss', file_id: 'l1' }];
  sb.tables.workspace_context_files.push({ id: 'l1', workspace_id: WS, title: 'Win/loss', kind: 'reference', body: 'x', visibility: 'workspace', created_by: 'op', updated_at: '1' });
  await assert.rejects(updateContextFile(sb, WS, 'op', 'l1', { visibility: 'operators' }), /stays shared/);
  const { file } = await pushDocument(sb, WS, 'op', { title: 'A', folder: 'S', body: 'y' });
  await assert.rejects(updateContextFile(sb, WS, 'op', file.id, { kind: 'about', visibility: 'operators' }), /shared with the workspace/);
});
