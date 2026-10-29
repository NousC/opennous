// The company repo behind Context (GET-1037): files sync both ways, the latest edit wins and the other
// is kept as a version, and a commit carries its change note and author.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
const { encryptValue } = await import('../src/providers/crypto.mjs');
const { slugOf, titleOf, syncable, latestWins, signatureOk, pullContextRepo, pushContextFile } = await import('../src/lib/contextRepo.mjs');

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

// A fake GitHub: a branch with files, commits per path, and the PUTs it received.
function github(files, commits = {}) {
  const puts = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    if (/\/branches\//.test(u.pathname)) return json({ commit: { commit: { tree: { sha: 'tree1' } } } });
    if (/\/git\/trees\//.test(u.pathname)) return json({ tree: Object.entries(files).map(([path, f]) => ({ type: 'blob', path, sha: f.sha })) });
    if (/\/git\/blobs\//.test(u.pathname)) { const sha = u.pathname.split('/').pop(); const f = Object.values(files).find(x => x.sha === sha); return json({ content: Buffer.from(f.text).toString('base64') }); }
    if (/\/commits$/.test(u.pathname)) { const c = commits[u.searchParams.get('path')]; return json(c ? [c] : []); }
    if (/\/contents\//.test(u.pathname) && init.method === 'PUT') {
      const body = JSON.parse(init.body); const path = decodeURIComponent(u.pathname.split('/contents/')[1]);
      puts.push({ path, ...body, text: Buffer.from(body.content, 'base64').toString('utf8') });
      return json({ content: { sha: `sha-${puts.length}` } }, 201);
    }
    return json({}, 404);
  };
  return puts;
}

const WS = 'ws1';
const repoRow = { workspace_id: WS, github_repo: 'acme/gtm', github_branch: 'main', base_path: 'context', github_token_enc: encryptValue('github_pat_test'), auto_sync: true, connected_by: 'u1' };
const commit = (sha, message, name, at) => ({ sha, commit: { message, author: { name, email: `${name}@acme.example`, date: at } } });

test('slugs, titles, what syncs, and which edit wins', () => {
  assert.equal(slugOf('Win/loss — Q4'), 'win-loss-q4');
  assert.equal(titleOf('context/battlecard.md', '# Battlecard: Brightlist\n…'), 'Battlecard: Brightlist');
  assert.equal(titleOf('context/win-loss.md', 'no heading'), 'Win loss');
  assert.equal(syncable({ visibility: 'workspace' }), true);
  assert.equal(syncable({ visibility: 'boxes' }), false, 'a file for private boxes stays out of the company repo');
  assert.equal(syncable({ visibility: 'workspace', document_id: 'd1' }), false);
  assert.equal(latestWins({ appEditedAt: '2026-10-26T10:00:00Z', repoCommittedAt: '2026-10-26T11:00:00Z' }), 'repo');
  assert.equal(latestWins({ appEditedAt: '2026-10-26T12:00:00Z', repoCommittedAt: '2026-10-26T11:00:00Z' }), 'app');
});

test('the webhook signature is checked over the raw body', () => {
  const raw = Buffer.from('{"ref":"refs/heads/main"}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(raw).digest('hex');
  assert.equal(signatureOk('s3cret', raw, sig), true);
  assert.equal(signatureOk('s3cret', raw, sig.replace(/.$/, '0')), false);
  assert.equal(signatureOk(null, raw, sig), false);
});

test('an edit in the repo becomes a new version, by its author, with the commit message', async () => {
  const sb = db({ workspace_context_files: [{ id: 'f1', workspace_id: WS, title: 'ICP', kind: 'icp', body: 'old', visibility: 'workspace', repo_path: 'context/icp.md', git_sha: 'b1', repo_synced_at: '2026-10-26T09:00:00Z', updated_at: '2026-10-26T09:00:00Z' }] });
  github({ 'context/icp.md': { sha: 'b2', text: 'new from Claude Code' } }, { 'context/icp.md': commit('c2', 'icp: drop agencies', 'Ines', '2026-10-26T10:00:00Z') });
  const changed = [];
  const out = await pullContextRepo(sb, repoRow, { afterChange: f => changed.push(f.kind) });
  assert.deepEqual(out, { pulled: 1, created: 0, pushed_back: 0, unchanged: 0 });
  const f = sb.tables.workspace_context_files[0];
  assert.equal(f.body, 'new from Claude Code'); assert.equal(f.git_sha, 'b2');
  const v = sb.tables.workspace_context_file_versions[0];
  assert.deepEqual([v.author_kind, v.author_name, v.changelog, v.git_sha, v.body], ['repo', 'Ines', 'icp: drop agencies', 'c2', 'new from Claude Code']);
  assert.deepEqual(changed, ['icp'], 'the ICP mirror follows');
});

test('a new file in the repo becomes a shared context file', async () => {
  const sb = db({ workspace_context_files: [] });
  github({ 'context/battlecard-brightlist.md': { sha: 'b9', text: '# Battlecard: Brightlist\nThey pitch price.' }, 'context/sub/skip.md': { sha: 'x', text: 'nested' }, 'README.md': { sha: 'y', text: 'outside' } },
    { 'context/battlecard-brightlist.md': commit('c9', 'add battlecard', 'Ines', '2026-10-26T10:00:00Z') });
  const out = await pullContextRepo(sb, repoRow);
  assert.equal(out.created, 1);
  const f = sb.tables.workspace_context_files[0];
  assert.deepEqual([f.title, f.visibility, f.created_by, f.repo_path], ['Battlecard: Brightlist', 'workspace', 'u1', 'context/battlecard-brightlist.md']);
  assert.match(sb.tables.workspace_context_file_versions[0].changelog, /^Added in the repo: add battlecard/);
});

test('both changed: the later edit from the app wins, and the repo text is kept as a version', async () => {
  const sb = db({ workspace_context_files: [{ id: 'f1', workspace_id: WS, title: 'Win/loss', kind: 'reference', body: 'app edit', visibility: 'workspace', repo_path: 'context/win-loss.md', git_sha: 'b1', repo_synced_at: '2026-10-26T09:00:00Z', updated_at: '2026-10-26T12:00:00Z' }] });
  const puts = github({ 'context/win-loss.md': { sha: 'b2', text: 'repo edit' } }, { 'context/win-loss.md': commit('c2', 'tweak', 'Ines', '2026-10-26T11:00:00Z') });
  const out = await pullContextRepo(sb, repoRow);
  assert.equal(out.pushed_back, 1);
  assert.equal(sb.tables.workspace_context_files[0].body, 'app edit');
  assert.equal(puts[0].text, 'app edit'); assert.equal(puts[0].sha, 'b2');
  assert.equal(sb.tables.workspace_context_file_versions[0].body, 'repo edit', 'the repo text is not lost');
});

test('both changed: the later edit in the repo wins, and the app text stays in its history', async () => {
  const sb = db({ workspace_context_files: [{ id: 'f1', workspace_id: WS, title: 'Win/loss', kind: 'reference', body: 'app edit', visibility: 'workspace', repo_path: 'context/win-loss.md', git_sha: 'b1', repo_synced_at: '2026-10-26T09:00:00Z', updated_at: '2026-10-26T10:00:00Z' }] });
  github({ 'context/win-loss.md': { sha: 'b2', text: 'repo edit' } }, { 'context/win-loss.md': commit('c2', 'tweak', 'Ines', '2026-10-26T11:00:00Z') });
  const out = await pullContextRepo(sb, repoRow);
  assert.equal(out.pulled, 1);
  assert.equal(sb.tables.workspace_context_files[0].body, 'repo edit');
});

test('a save is committed with its change note as the message and its writer as the author', async () => {
  const sb = db({
    workspace_context_repos: [repoRow],
    workspace_context_files: [{ id: 'f1', workspace_id: WS, title: 'Win/loss', kind: 'reference', body: '+2 losses', visibility: 'workspace', repo_path: null, git_sha: null },
      { id: 'f2', workspace_id: WS, title: 'Private notes', kind: 'reference', body: 'x', visibility: 'boxes' }],
  });
  const puts = github({});
  assert.equal((await pushContextFile(sb, WS, 'f1', { who: { kind: 'opennous' }, changelog: '+2 losses to Brightlist, price' })).status, 'pushed');
  assert.deepEqual([puts[0].path, puts[0].message, puts[0].author.name], ['context/win-loss.md', 'win-loss: +2 losses to Brightlist, price', 'OpenNous']);
  assert.equal(sb.tables.workspace_context_files[0].repo_path, 'context/win-loss.md');
  await pushContextFile(sb, WS, 'f1', { who: { kind: 'person', userId: 'u1' }, changelog: 'reworded' });
  assert.deepEqual(puts[1].author, { name: 'Olive Owner', email: 'olive@acme.example' });
  assert.equal(puts[1].sha, 'sha-1', 'the second commit builds on the first');
  assert.equal((await pushContextFile(sb, WS, 'f2', {})).status, 'skipped', 'a private file never goes to the repo');
});
