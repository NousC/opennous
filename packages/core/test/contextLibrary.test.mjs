// Workspace context library (GET-875): files saved once, tagged to several RevBoxes; backfill
// equivalence with revbox_context; privacy; one ICP file; run context only from linked files; the
// ICP file is what the scorecard seed reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listContextLibrary, createContextFile, updateContextFile, deleteContextFile, linkContextFile, loadContextFile,
  revboxContextRows, workspaceIcpContext, scorecardSeedText, contextFileVisible,
} from '../dist/db/contextLibrary.mjs';
import { revboxDetails, addRevboxContext, removeRevboxContext, saveRevboxJob } from '../dist/db/revboxes.mjs';
import { revboxRoutineContext } from '../dist/services/automationRun.mjs';

const WS = 'ws-1';
// A small PostgREST-like fake. `missing` tables answer 42P01 like an unmigrated database.
function database(seed = {}, { missing = [] } = {}) {
  const tables = {
    workspace_members: [{ workspace_id: WS, user_id: 'owner', role: 'owner' }, { workspace_id: WS, user_id: 'member', role: 'member' }, { workspace_id: WS, user_id: 'admin', role: 'admin' }],
    revboxes: [
      { id: 'box-private', workspace_id: WS, owner_id: 'owner', shared: false, name: 'Private box', revision: 1, scope: { mode: 'all', account_ids: [], min_icp: 0 }, blocks: [], delivery: [] },
      { id: 'box-shared', workspace_id: WS, owner_id: 'owner', shared: true, name: 'Shared box', revision: 1, scope: { mode: 'all', account_ids: [], min_icp: 0 }, blocks: [], delivery: [] },
      { id: 'box-member', workspace_id: WS, owner_id: 'member', shared: false, name: 'Member box', revision: 1, scope: { mode: 'all', account_ids: [], min_icp: 0 }, blocks: [], delivery: [] },
    ],
    revbox_members: [], revbox_jobs: [], revbox_context: [], workspace_context_files: [], revbox_context_links: [], documents: [],
    ...seed,
  };
  let seq = 0;
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select() { return this; } order() { return this; } limit() { return this; } neq(k, v) { this.filters.push(r => r[k] !== v); return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    in(k, vs) { this.filters.push(r => vs.includes(r[k])); return this; }
    insert(v) { this.op = 'insert'; this.value = v; return this; }
    update(v) { this.op = 'update'; this.value = v; return this; }
    upsert(v) { this.op = 'upsert'; this.value = v; return this; }
    delete() { this.op = 'delete'; return this; }
    run(single) {
      if (missing.includes(this.table)) return { data: null, error: { code: '42P01', message: `relation "public.${this.table}" does not exist` } };
      const all = (tables[this.table] ??= []);
      let values = all.filter(r => this.filters.every(f => f(r)));
      if (this.op === 'insert' && this.table === 'workspace_context_files' && this.value.kind === 'icp' && all.some(r => r.kind === 'icp' && r.workspace_id === this.value.workspace_id)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "workspace_context_files_one_icp"' } };
      if (this.op === 'insert') { const row = structuredClone({ id: `${this.table}-${++seq}`, created_at: `t${String(seq).padStart(3, '0')}`, updated_at: `t${String(seq).padStart(3, '0')}`, ...this.value }); all.push(row); values = [row]; }
      if (this.op === 'upsert') { const v = this.value; if (!all.some(r => r.revbox_id === v.revbox_id && r.context_file_id === v.context_file_id)) all.push({ created_at: `t${String(++seq).padStart(3, '0')}`, ...v }); values = []; }
      if (this.op === 'update') {
        if (this.table === 'workspace_context_files' && this.value.kind === 'icp' && all.some(r => r.kind === 'icp' && r.workspace_id === WS && !values.includes(r))) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "workspace_context_files_one_icp"' } };
        for (const r of values) Object.assign(r, structuredClone(this.value));
      }
      if (this.op === 'delete') {
        tables[this.table] = all.filter(r => !values.includes(r));
        if (this.table === 'workspace_context_files') tables.revbox_context_links = tables.revbox_context_links.filter(l => !values.some(f => f.id === l.context_file_id));
      }
      return { data: structuredClone(single ? values[0] ?? null : values), error: null };
    }
    maybeSingle() { return Promise.resolve(this.run(true)); } single() { return this.maybeSingle(); }
    then(res, rej) { return Promise.resolve(this.run(false)).then(res, rej); }
  }
  return { tables, from: t => new Query(t) };
}

// The SQL backfill (2026_10_15_context_library.sql), row for row: same id, kind reference, visibility boxes.
function backfill(sb) {
  for (const c of sb.tables.revbox_context) {
    if (!sb.tables.workspace_context_files.some(f => f.id === c.id)) sb.tables.workspace_context_files.push({ id: c.id, workspace_id: c.workspace_id, title: c.title, kind: 'reference', body: c.body, document_id: c.document_id, visibility: 'boxes', created_by: c.created_by, created_at: c.created_at, updated_at: c.created_at });
    if (!sb.tables.revbox_context_links.some(l => l.revbox_id === c.revbox_id && l.context_file_id === c.id)) sb.tables.revbox_context_links.push({ revbox_id: c.revbox_id, context_file_id: c.id, workspace_id: c.workspace_id, created_by: c.created_by, created_at: c.created_at });
  }
}
const legacyRows = () => [
  { id: 'c1', revbox_id: 'box-private', workspace_id: WS, title: 'ICP.md', body: 'Mid-market SaaS.', document_id: null, created_by: 'owner', created_at: '2026-10-14T10:00:00Z' },
  { id: 'c2', revbox_id: 'box-private', workspace_id: WS, title: 'Voice.md', body: 'Short sentences.', document_id: null, created_by: 'owner', created_at: '2026-10-14T11:00:00Z' },
  { id: 'c3', revbox_id: 'box-shared', workspace_id: WS, title: 'Playbook', body: '', document_id: 'doc-1', created_by: 'owner', created_at: '2026-10-14T12:00:00Z' },
];
const pick = (rs) => rs.map(r => ({ id: r.id, title: r.title, body: r.body, document_id: r.document_id }));

test('backfill: every box reads exactly the context it read before the migration', async () => {
  const before = database({ revbox_context: legacyRows() }, { missing: ['workspace_context_files', 'revbox_context_links'] });
  const after = database({ revbox_context: legacyRows() });
  backfill(after); backfill(after);   // re-running the migration adds nothing
  assert.equal(after.tables.workspace_context_files.length, 3); assert.equal(after.tables.revbox_context_links.length, 3);
  for (const box of ['box-private', 'box-shared']) {
    const old = pick(await revboxContextRows(before, WS, box));
    assert.ok(old.length > 0);
    assert.deepEqual(pick(await revboxContextRows(after, WS, box)), old);
    assert.deepEqual(pick((await revboxDetails(after, WS, 'owner', box)).context), old);
  }
  // A row an older API wrote after the migration still counts, once.
  after.tables.revbox_context.push({ id: 'late', revbox_id: 'box-private', workspace_id: WS, title: 'Late.md', body: 'x', document_id: null, created_by: 'owner', created_at: '2026-10-15T00:00:00Z' });
  assert.deepEqual((await revboxContextRows(after, WS, 'box-private')).map(r => r.id), ['c1', 'c2', 'late']);
});

test('one file tagged to many boxes; untagging one box keeps the others', async () => {
  const sb = database();
  const file = await createContextFile(sb, WS, 'owner', { title: 'Pricing notes', body: 'List price 10k.', revbox_ids: ['box-private', 'box-shared'] });
  assert.deepEqual(file.boxes.map(b => b.id).sort(), ['box-private', 'box-shared']);
  for (const box of ['box-private', 'box-shared']) assert.deepEqual((await revboxDetails(sb, WS, 'owner', box)).context.map(c => c.id), [file.id]);
  await removeRevboxContext(sb, WS, 'owner', 'box-private', file.id);
  assert.equal((await revboxDetails(sb, WS, 'owner', 'box-private')).context.length, 0);
  assert.deepEqual((await revboxDetails(sb, WS, 'owner', 'box-shared')).context.map(c => c.id), [file.id]);
  assert.equal(sb.tables.workspace_context_files.length, 1, 'untagging never deletes the file');
  // Tag it back from the box page ("Add from library"), and retag from Settings to one box.
  await addRevboxContext(sb, WS, 'owner', 'box-private', { file_id: file.id });
  assert.equal((await revboxDetails(sb, WS, 'owner', 'box-private')).context.length, 1);
  const retagged = await updateContextFile(sb, WS, 'owner', file.id, { revbox_ids: ['box-shared'] });
  assert.deepEqual(retagged.boxes.map(b => b.id), ['box-shared']);
  // Box-page uploads land in the library, tagged to that box.
  const up = await addRevboxContext(sb, WS, 'owner', 'box-shared', { title: 'Notes.md', body: 'hello' });
  assert.deepEqual(up.boxes.map(b => b.id), ['box-shared']);
  assert.equal((await listContextLibrary(sb, WS, 'owner')).files.length, 2);
  // A job snapshot still records the box's context ids.
  const job = await saveRevboxJob(sb, WS, 'owner', 'box-shared', { name: 'Weekly', prompt: 'Every Monday at 9am summarise in Slack.', state: 'reviewed' });
  assert.deepEqual(job.snapshots.at(-1).context_references.map(r => r.id).sort(), [file.id, up.id].sort());
});

test('privacy: a file on a private box stays private; tags on hidden boxes are only counted', async () => {
  const sb = database({ revbox_context: legacyRows() });
  backfill(sb);
  const ids = async (uid) => (await listContextLibrary(sb, WS, uid)).files.map(f => f.id).sort();
  assert.deepEqual(await ids('owner'), ['c1', 'c2', 'c3']);
  assert.deepEqual(await ids('member'), ['c3'], 'member sees only the shared box file');
  await assert.rejects(loadContextFile(sb, WS, 'member', 'c1'), e => e.status === 404);
  await assert.rejects(updateContextFile(sb, WS, 'member', 'c1', { title: 'x' }), e => e.status === 404);
  // Tag c1 to the shared box as well: the member now sees it, with only the shared box named.
  await updateContextFile(sb, WS, 'owner', 'c1', { revbox_ids: ['box-private', 'box-shared'] });
  const seen = (await listContextLibrary(sb, WS, 'member')).files.find(f => f.id === 'c1');
  assert.deepEqual(seen.boxes.map(b => b.name), ['Shared box']);
  assert.equal(seen.hidden_boxes, 1);
  // The member retags it among the boxes THEY can see; the private tag survives. A viewer of the
  // shared box cannot change its context.
  await assert.rejects(updateContextFile(sb, WS, 'member', 'c1', { revbox_ids: [] }), e => e.status === 403);
  // An untagged file is its creator's; a workspace file is everyone's; nobody else can tag to a box they can't open.
  const mine = await createContextFile(sb, WS, 'member', { title: 'Draft', body: 'x' });
  assert.deepEqual(mine.boxes, []);
  assert.ok(!(await ids('owner')).includes(mine.id));
  await updateContextFile(sb, WS, 'member', mine.id, { visibility: 'workspace' });
  assert.ok((await ids('owner')).includes(mine.id));
  await assert.rejects(createContextFile(sb, WS, 'member', { title: 'x', body: 'y', revbox_ids: ['box-private'] }), e => e.status === 404);
  assert.equal(contextFileVisible({ visibility: 'boxes', created_by: 'a' }, 'b', new Set(['x']), ['y']), false);
  // Only the creator or an admin deletes.
  await assert.rejects(deleteContextFile(sb, WS, 'member', 'c3'), e => e.status === 403);
  await deleteContextFile(sb, WS, 'owner', 'c3');
  assert.equal(sb.tables.revbox_context.some(r => r.id === 'c3'), false, 'legacy copy goes too');
  assert.equal((await revboxDetails(sb, WS, 'owner', 'box-shared')).context.some(c => c.id === 'c3'), false);
});

test('one ICP file per workspace, chosen by an owner or admin, always shared with the workspace', async () => {
  const sb = database();
  const a = await createContextFile(sb, WS, 'owner', { title: 'ICP', body: 'B2B SaaS, 100-1000 staff.' });
  const b = await createContextFile(sb, WS, 'admin', { title: 'Other ICP', body: 'Agencies.' });
  await assert.rejects(updateContextFile(sb, WS, 'member', a.id, { kind: 'icp' }), e => e.status === 404 || e.status === 403);
  const marked = await updateContextFile(sb, WS, 'owner', a.id, { kind: 'icp' });
  assert.equal(marked.kind, 'icp'); assert.equal(marked.visibility, 'workspace');
  await assert.rejects(updateContextFile(sb, WS, 'admin', b.id, { kind: 'icp' }), e => e.status === 409);
  await assert.rejects(updateContextFile(sb, WS, 'owner', a.id, { visibility: 'boxes' }), e => e.status === 400);
  await assert.rejects(createContextFile(sb, WS, 'member', { title: 'Mine', body: 'x', kind: 'icp' }), e => e.status === 403);
  // Everyone in the workspace now sees it.
  assert.ok((await listContextLibrary(sb, WS, 'member')).files.some(f => f.id === a.id && f.kind === 'icp'));
  // Unmark, then the other one can be marked.
  await updateContextFile(sb, WS, 'owner', a.id, { kind: 'reference' });
  assert.equal((await updateContextFile(sb, WS, 'admin', b.id, { kind: 'icp' })).kind, 'icp');
  // A non-admin can still switch their own file between reference and instructions.
  const own = await createContextFile(sb, WS, 'member', { title: 'Tone', body: 'x' });
  assert.equal((await updateContextFile(sb, WS, 'member', own.id, { kind: 'instructions' })).kind, 'instructions');
});

test('a run reads only the files tagged to its own box', async () => {
  const sb = database();
  await createContextFile(sb, WS, 'owner', { title: 'Shared knowledge', body: 'WORKSPACE-ONLY', visibility: 'workspace' });
  await createContextFile(sb, WS, 'owner', { title: 'Other box', body: 'OTHER-BOX', revbox_ids: ['box-shared'] });
  await createContextFile(sb, WS, 'owner', { title: 'This box', body: 'THIS-BOX', revbox_ids: ['box-private'] });
  const ctx = await revboxRoutineContext(sb, WS, { revbox_id: 'box-private', user_id: 'owner' });
  assert.equal(ctx.ok, true);
  assert.match(ctx.text, /THIS-BOX/);
  assert.doesNotMatch(ctx.text, /OTHER-BOX|WORKSPACE-ONLY/);
});

test('the ICP file is what the scorecard is built from', async () => {
  const sb = database({ documents: [{ id: 'doc-icp', workspace_id: WS, title: 'ICP doc', body_md: 'Logistics firms, 200+ staff.', status: 'live' }] });
  assert.equal(await workspaceIcpContext(sb, WS), null);
  const notes = [{ category: 'ICP', content: 'Old ICP prose.' }, { category: 'general', content: 'Older ICP note.', metadata: { category_raw: 'ICP' } }, { category: 'Market', content: 'EU only.' }];
  assert.equal(scorecardSeedText(notes, null), '[ICP] Old ICP prose.\n[general] Older ICP note.\n[Market] EU only.');
  const f = await createContextFile(sb, WS, 'owner', { title: 'ICP', body: 'B2B SaaS, RevOps owner, HubSpot.', kind: 'icp' });
  const icp = await workspaceIcpContext(sb, WS);
  assert.equal(icp.id, f.id); assert.equal(icp.text, 'B2B SaaS, RevOps owner, HubSpot.');
  assert.equal(scorecardSeedText(notes, icp), '[ICP] B2B SaaS, RevOps owner, HubSpot.\n[Market] EU only.');
  // Editing the ICP file changes what the next build reads.
  await updateContextFile(sb, WS, 'owner', f.id, { body: 'Fintech only.' });
  assert.equal((await workspaceIcpContext(sb, WS)).text, 'Fintech only.');
  // A linked document as the ICP: its current text.
  await updateContextFile(sb, WS, 'owner', f.id, { kind: 'reference' });
  await createContextFile(sb, WS, 'owner', { title: 'ICP doc', document_id: 'doc-icp', kind: 'icp' });
  assert.equal((await workspaceIcpContext(sb, WS)).text, 'Logistics firms, 200+ staff.');
  // Before the migration: no ICP file, scoring reads the notes as before.
  assert.equal(await workspaceIcpContext(database({}, { missing: ['workspace_context_files'] }), WS), null);
});

// Review findings on 06468fe71 (GET-875).
test('only an owner or admin changes or deletes the ICP file, even its creator', async () => {
  const sb = database();
  const f = await createContextFile(sb, WS, 'member', { title: 'ICP', body: 'v1', visibility: 'workspace', revbox_ids: ['box-member'] });
  await updateContextFile(sb, WS, 'admin', f.id, { kind: 'icp' });
  await assert.rejects(updateContextFile(sb, WS, 'member', f.id, { body: 'v2' }), e => e.status === 403);
  await assert.rejects(updateContextFile(sb, WS, 'member', f.id, { title: 'x' }), e => e.status === 403);
  await assert.rejects(deleteContextFile(sb, WS, 'member', f.id), e => e.status === 403);
  assert.equal((await listContextLibrary(sb, WS, 'member')).files.find(x => x.id === f.id).can_edit, false);
  assert.equal((await updateContextFile(sb, WS, 'admin', f.id, { body: 'v2' })).body, 'v2');
});

test('a box editor cannot change a file that is also tagged to a box they cannot see', async () => {
  const sb = database();
  const f = await createContextFile(sb, WS, 'owner', { title: 'Shared notes', body: 'x', revbox_ids: ['box-private', 'box-shared'] });
  sb.tables.revbox_members.push({ workspace_id: WS, revbox_id: 'box-shared', user_id: 'member', role: 'editor' });
  await assert.rejects(updateContextFile(sb, WS, 'member', f.id, { body: 'changed' }), e => e.status === 403);
  await assert.rejects(updateContextFile(sb, WS, 'member', f.id, { visibility: 'workspace' }), e => e.status === 403);
  assert.equal((await listContextLibrary(sb, WS, 'member')).files.find(x => x.id === f.id).can_edit, false);
  // Editor of every tagged box: allowed.
  const g = await createContextFile(sb, WS, 'owner', { title: 'Only shared', body: 'x', revbox_ids: ['box-shared'] });
  assert.equal((await updateContextFile(sb, WS, 'member', g.id, { body: 'ok' })).body, 'ok');
});

test('creating a second ICP file is refused before anything is written', async () => {
  const sb = database();
  await createContextFile(sb, WS, 'owner', { title: 'ICP', body: 'a', kind: 'icp' });
  const files = sb.tables.workspace_context_files.length, links = sb.tables.revbox_context_links.length;
  await assert.rejects(createContextFile(sb, WS, 'owner', { title: 'ICP 2', body: 'b', kind: 'icp', revbox_ids: ['box-shared'] }), e => e.status === 409);
  assert.equal(sb.tables.workspace_context_files.length, files, 'no orphan file');
  assert.equal(sb.tables.revbox_context_links.length, links);
});

test('unmarking the ICP file restores the visibility it had before', async () => {
  const sb = database();
  const f = await createContextFile(sb, WS, 'owner', { title: 'ICP', body: 'a', revbox_ids: ['box-private'] });
  assert.equal(f.visibility, 'boxes');
  assert.equal((await updateContextFile(sb, WS, 'owner', f.id, { kind: 'icp' })).visibility, 'workspace');
  const off = await updateContextFile(sb, WS, 'owner', f.id, { kind: 'reference' });
  assert.equal(off.visibility, 'boxes');
  assert.ok(!(await listContextLibrary(sb, WS, 'member')).files.some(x => x.id === f.id));
  // A file that was already workspace-wide stays so.
  const w = await createContextFile(sb, WS, 'owner', { title: 'W', body: 'a', visibility: 'workspace' });
  await updateContextFile(sb, WS, 'owner', w.id, { kind: 'icp' });
  assert.equal((await updateContextFile(sb, WS, 'owner', w.id, { kind: 'instructions' })).visibility, 'workspace');
});

test('the library reads tags only for the files it lists', async () => {
  const sb = database();
  const f = await createContextFile(sb, WS, 'owner', { title: 'A', body: 'a', revbox_ids: ['box-shared'] });
  const seen = [];
  const from = sb.from;
  sb.from = (t) => { const q = from(t); if (t !== 'revbox_context_links') return q; const inner = q.in.bind(q); q.in = (k, vs) => { seen.push([k, vs]); return inner(k, vs); }; return q; };
  const lib = await listContextLibrary(sb, WS, 'owner');
  assert.deepEqual(lib.files[0].boxes.map(b => b.id), ['box-shared']);
  assert.ok(seen.some(([k, vs]) => k === 'context_file_id' && vs.includes(f.id)));
});
