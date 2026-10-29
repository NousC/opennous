// GET-875: the context file marked ICP is mirrored into the ICP foundation (writeIcp), so readIcp,
// query { foundation: 'icp' } and the per-contact ICP scorers (which read the ICP note writeIcp
// saves) read the same text as the scorecard seed. Unmarking leaves the last text in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mirrorIcpFile } from '../src/lib/icpContextFile.mjs';
import { readIcp } from '../src/lib/icp.mjs';

const WS = '00000000-0000-0000-0000-000000000001';
function database(tables) {
  const writes = [];
  const from = (table) => {
    const filters = []; let op = null; let value = null;
    const run = (single) => {
      const all = (tables[table] ??= []);
      if (op === 'upsert') { writes.push({ table, op }); const i = all.findIndex(r => r.workspace_id === value.workspace_id && r.kind === value.kind); if (i >= 0) all[i] = { ...all[i], ...value }; else all.push({ ...value }); return { data: null, error: null }; }
      if (op === 'insert') { writes.push({ table, op }); all.push({ id: `row-${all.length + 1}`, ...value }); return { data: { id: `row-${all.length}`, ...value }, error: null }; }
      const hit = all.filter(r => filters.every(([k, v]) => r[k] === v));
      if (op === 'update') { writes.push({ table, op }); for (const r of hit) Object.assign(r, value); return { data: null, error: null }; }
      return { data: single ? hit[0] ?? null : hit, error: null };
    };
    const q = new Proxy({}, { get(_, p) {
      if (p === 'then') return (res, rej) => Promise.resolve(run(false)).then(res, rej);
      if (p === 'maybeSingle' || p === 'single') return () => Promise.resolve(run(true));
      if (p === 'eq') return (k, v) => { filters.push([k, v]); return q; };
      if (['insert', 'update', 'upsert'].includes(p)) return (v) => { op = p; value = v; return q; };
      return () => q;
    } });
    return q;
  };
  return { tables, writes, from };
}
const icpFile = (text) => async () => (text == null ? null : { id: 'f1', title: 'ICP', text, updated_at: 't' });

test('marking a file ICP writes its text to the ICP foundation, the ICP note and the cache', async () => {
  const sb = database({ foundations: [{ workspace_id: WS, kind: 'icp', body_md: 'Old ICP.', version: 3, source: 'nous', file_path: null }], workspaces: [{ id: WS }], entities: [{ id: 'ws-entity', workspace_id: WS, kind: 'workspace' }] });
  const out = await mirrorIcpFile(sb, WS, { icp: icpFile('Logistics firms, 200+ staff.') });
  assert.equal(out.status, 'mirrored');
  assert.equal((await readIcp(sb, WS)).body_md, 'Logistics firms, 200+ staff.');
  assert.equal(sb.tables.foundations[0].version, 4);
  assert.equal(sb.tables.workspaces[0].icp_text, 'Logistics firms, 200+ staff.');
});

test('the same text again writes nothing; a repo-sourced ICP keeps its source and file path', async () => {
  const sb = database({ foundations: [{ workspace_id: WS, kind: 'icp', body_md: 'Same.', version: 1, source: 'claude_code', file_path: 'gtm/ICP.md' }], workspaces: [{ id: WS }] });
  assert.equal((await mirrorIcpFile(sb, WS, { icp: icpFile('Same.') })).status, 'unchanged');
  assert.equal(sb.writes.length, 0);
  await mirrorIcpFile(sb, WS, { icp: icpFile('New text.') });
  assert.equal(sb.tables.foundations[0].source, 'claude_code');
  assert.equal(sb.tables.foundations[0].file_path, 'gtm/ICP.md');
});

test('no ICP file (unmarked) leaves the foundation as it was', async () => {
  const sb = database({ foundations: [{ workspace_id: WS, kind: 'icp', body_md: 'Last text.', version: 2, source: 'nous' }] });
  assert.equal((await mirrorIcpFile(sb, WS, { icp: icpFile(null) })).status, 'no_icp_file');
  assert.equal(sb.writes.length, 0);
  assert.equal((await readIcp(sb, WS)).body_md, 'Last text.');
});

test('a file whose linked document the viewer cannot read cannot be changed by them', async () => {
  const { contextFileDocumentGate } = await import('../src/routes/api/context.mjs');
  const notFound = async () => { throw Object.assign(new Error('Document not found.'), { status: 404 }); };
  await assert.rejects(contextFileDocumentGate({ document_id: 'doc-1' }, notFound), e => e.status === 404 && /Context file not found/.test(e.message));
  let read = 0;
  await contextFileDocumentGate({ document_id: 'doc-1' }, async () => { read++; return { id: 'doc-1' }; });
  await contextFileDocumentGate({ document_id: null }, notFound);   // a text file has no document to check
  assert.equal(read, 1);
  await assert.rejects(contextFileDocumentGate({ document_id: 'doc-1' }, async () => { throw new Error('db down'); }), /db down/);
});

test('a saved file is returned with its document only while the viewer can read it, never the raw row', async () => {
  const { readableContextFile } = await import('../src/routes/api/context.mjs');
  const file = { id: 'f', title: 'Secret account plan', body: '', document_id: 'doc-1', kind: 'reference' };
  const hidden = await readableContextFile(file, async () => { throw Object.assign(new Error('nf'), { status: 404 }); });
  assert.equal(hidden.title, 'Linked document'); assert.equal(hidden.body, '');
  const shown = await readableContextFile(file, async () => ({ id: 'doc-1', title: 'Plan', body_md: 'text' }));
  assert.equal(shown.title, 'Plan'); assert.equal(shown.body, 'text');
  assert.equal((await readableContextFile({ id: 'g', title: 'T', body: 'b', document_id: null }, async () => { throw new Error('unused'); })).body, 'b');
});
