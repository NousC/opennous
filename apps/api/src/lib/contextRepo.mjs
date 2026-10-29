// The company repo behind Settings > Knowledge (GET-1037): where a workspace's context lives as its own.
// Open source since 2026-10-29 (was cloud/lib/contextRepo.mjs).
//
// A workspace connects one GitHub repo. Every context file shared with the workspace (the ICP, About
// us, playbooks, and the living files OpenNous keeps current) syncs both ways as
// <base_path>/<file>.md, one folder whoever wrote it:
//   - app → repo: each saved change is one commit. Its message is the version's change note and its
//     author is who wrote it: the person, or OpenNous. Git history is the version history.
//   - repo → app: a push (webhook, or the 10-minute poll when the token cannot add one) is read as a
//     tree diff by blob sha. A changed file becomes a new version, authored by the commit's author,
//     with the commit message as its change note; a new .md file becomes a new context file.
//   - both changed since the last sync: the latest edit wins and the other is kept as a version
//     (Bennet, 2026-10-26), so nothing is lost.
// A file deleted in the repo stays in the app (nothing is deleted here); a file tagged only to
// private boxes never goes to the repo; a linked document is read from its document, not synced.
import crypto from 'node:crypto';
import { recordContextVersion } from '@nous/core';
import { encryptValue, decrypt } from '../providers/crypto.mjs';
import { validateRepo, registerWebhook, deleteWebhook, fetchTree, fetchBlob } from './personalGithub.mjs';
import { publicApiBase } from './publicApiBase.mjs';

const GH = 'https://api.github.com';
const OPENNOUS = { name: 'OpenNous', email: 'agent@opennous.cloud' };
const REPO_COLS = 'workspace_id, github_repo, github_branch, base_path, github_token_enc, webhook_id, webhook_secret, sync_token, auto_sync, sync_status, last_error, last_synced_at, last_synced_via, last_polled_at, connected_by, created_at, updated_at';
const SYNC_COLS = 'id, workspace_id, title, kind, body, document_id, visibility, created_by, updated_by, updated_at, repo_path, git_sha, repo_synced_at';
const MAX_PULL = 200;

const headers = (token) => ({
  Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'opennous-context-sync',
});
const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');
const clean = (p) => String(p ?? '').replace(/^\/+|\/+$/g, '');
const missing = (e) => ['42P01', '42703', 'PGRST205', 'PGRST204'].includes(e?.code) || /workspace_context_repos|repo_path|git_sha/.test(e?.message ?? '');

/** A file name from a title: "Win/loss — Q4" → "win-loss-q4". Pure. */
export function slugOf(title) {
  const s = String(title ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return s || 'untitled';
}

/** A title from a repo file: its first "# " heading, else its name. Pure. */
export function titleOf(path, text) {
  const h = /^#\s+(.+)$/m.exec(String(text ?? ''))?.[1]?.trim();
  if (h) return h.slice(0, 200);
  const name = String(path).split('/').pop().replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
  return (name.charAt(0).toUpperCase() + name.slice(1)).slice(0, 200) || 'Untitled';
}

/** Does this file belong in the repo? Shared with the workspace, and its own text (not a linked doc). Pure. */
export const syncable = (f) => !!f && f.visibility === 'workspace' && !f.document_id;

/** Which side wins when both changed since the last sync: the later edit. Pure. */
export function latestWins({ appEditedAt, repoCommittedAt }) {
  return String(repoCommittedAt ?? '') > String(appEditedAt ?? '') ? 'repo' : 'app';
}

/** The workspace's repo connection, or null (none, or the migration not applied). */
export async function loadContextRepo(sb, ws) {
  const { data, error } = await sb.from('workspace_context_repos').select(REPO_COLS).eq('workspace_id', ws).maybeSingle();
  if (error) { if (missing(error)) return null; throw error; }
  return data ?? null;
}

/** The connection as the API returns it: never the token or the webhook secret. */
export function repoOut(r) {
  if (!r) return null;
  return {
    repo: r.github_repo, branch: r.github_branch, base_path: r.base_path, auto_sync: r.auto_sync,
    webhook: !!r.webhook_id, sync_status: r.sync_status, last_error: r.last_error,
    last_synced_at: r.last_synced_at, last_synced_via: r.last_synced_via, connected_at: r.created_at,
  };
}

const tokenOf = (r) => { try { const t = decrypt(r.github_token_enc); return t && t !== r.github_token_enc ? t : null; } catch { return null; } };

async function gh(token, path, init = {}) {
  return fetch(`${GH}${path}`, { ...init, headers: { ...headers(token), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) } });
}

/** The newest commit that touched `path`: { sha, message, author: { name, email }, at }, or null. */
async function lastCommit(token, cfg, path) {
  const r = await gh(token, `/repos/${cfg.github_repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(cfg.github_branch)}&per_page=1`);
  if (!r.ok) return null;
  const c = (await r.json())?.[0];
  if (!c) return null;
  return { sha: c.sha, message: String(c.commit?.message ?? '').split('\n')[0].slice(0, 200), author: { name: c.commit?.author?.name ?? null, email: c.commit?.author?.email ?? null }, at: c.commit?.author?.date ?? null };
}

/** The blob sha and text of `path` on the branch, or null when it is not there. */
async function readPath(token, cfg, path) {
  const r = await gh(token, `/repos/${cfg.github_repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(cfg.github_branch)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub read failed (${r.status})`);
  const d = await r.json();
  return { sha: d.sha, text: Buffer.from(d.content ?? '', 'base64').toString('utf8') };
}

/** Commit one file's text. -> the new blob sha. 409/422 (the repo moved under us) throws 'stale'. */
async function putPath(token, cfg, path, text, { message, author, sha }) {
  const r = await gh(token, `/repos/${cfg.github_repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: b64(text), branch: cfg.github_branch, ...(sha ? { sha } : {}), ...(author?.name && author?.email ? { author } : {}) }),
  });
  if (r.status === 409 || r.status === 422) throw Object.assign(new Error('stale'), { code: 'stale' });
  if (!r.ok) throw new Error(`GitHub commit failed (${r.status})`);
  return (await r.json())?.content?.sha ?? null;
}

/** Where `file` lives in the repo: its path once it has one, else <base>/<slug>.md, made unique. */
async function pathFor(sb, cfg, file) {
  if (file.repo_path) return file.repo_path;
  const base = clean(cfg.base_path);
  const slug = slugOf(file.title);
  const { data: taken } = await sb.from('workspace_context_files').select('id, repo_path').eq('workspace_id', file.workspace_id).like('repo_path', `${base ? `${base}/` : ''}${slug}%`);
  const used = new Set((taken ?? []).filter(t => t.id !== file.id).map(t => t.repo_path));
  let path = `${base ? `${base}/` : ''}${slug}.md`;
  for (let n = 2; used.has(path); n++) path = `${base ? `${base}/` : ''}${slug}-${n}.md`;
  return path;
}

/** The commit author for a version written by `who`: { kind: 'person', userId } or { kind: 'opennous' }. */
async function authorFor(sb, who) {
  if (who?.kind === 'opennous') return OPENNOUS;
  if (!who?.userId) return null;
  const { data: u } = await sb.from('users').select('name, email').eq('id', who.userId).maybeSingle();
  return u?.email ? { name: u.name || u.email, email: u.email } : null;
}

/**
 * Commit a file's current text to the repo (GET-1037). `who` is who wrote this version and
 * `changelog` its note (the commit message). Best-effort: no repo, a private or linked file, or
 * GitHub failing never fails the save; a failure is recorded on the connection. When the repo moved
 * under us since the last sync, the app's edit is the later one: it wins, and the repo's text is kept
 * as a version first. -> { status: 'pushed' | 'skipped' | 'failed' }
 */
export async function pushContextFile(sb, ws, fileId, { who = null, changelog = null } = {}) {
  try {
    const cfg = await loadContextRepo(sb, ws);
    if (!cfg?.auto_sync) return { status: 'skipped' };
    const { data: file, error } = await sb.from('workspace_context_files').select(SYNC_COLS).eq('workspace_id', ws).eq('id', fileId).maybeSingle();
    if (error) { if (missing(error)) return { status: 'skipped' }; throw error; }
    if (!syncable(file)) return { status: 'skipped' };
    const token = tokenOf(cfg);
    if (!token) throw new Error('The repo token cannot be read. Connect the repo again.');
    const path = await pathFor(sb, cfg, file);
    const message = `${slugOf(file.title)}: ${changelog || 'updated'}`.slice(0, 250);
    const author = await authorFor(sb, who);
    let sha;
    try {
      sha = await putPath(token, cfg, path, file.body ?? '', { message, author, sha: file.git_sha });
    } catch (e) {
      if (e.code !== 'stale') throw e;
      // Someone committed this file since we last saw it. Ours is the later edit: keep theirs as a
      // version, then commit over it.
      const theirs = await readPath(token, cfg, path);
      if (theirs && theirs.text !== (file.body ?? '')) {
        const c = await lastCommit(token, cfg, path);
        await recordContextVersion(sb, ws, { ...file, body: theirs.text }, { kind: 'repo', name: c?.author?.name ?? null, changelog: c?.message ? `From the repo: ${c.message}` : 'From the repo', gitSha: c?.sha ?? null });
      }
      sha = await putPath(token, cfg, path, file.body ?? '', { message, author, sha: theirs?.sha ?? null });
    }
    await sb.from('workspace_context_files').update({ repo_path: path, git_sha: sha, repo_synced_at: new Date().toISOString() }).eq('workspace_id', ws).eq('id', file.id);
    await sb.from('workspace_context_repos').update({ sync_status: 'ok', last_error: null, last_synced_at: new Date().toISOString(), last_synced_via: 'push', updated_at: new Date().toISOString() }).eq('workspace_id', ws);
    return { status: 'pushed', path, sha };
  } catch (e) {
    console.warn('[context-repo] push failed:', e?.message ?? e);
    await sb.from('workspace_context_repos').update({ sync_status: 'error', last_error: String(e?.message ?? e).slice(0, 300), updated_at: new Date().toISOString() }).eq('workspace_id', ws).then(() => {}, () => {});
    return { status: 'failed', error: String(e?.message ?? e) };
  }
}

/**
 * Read the repo into the workspace (GET-1037): every .md under base_path whose blob changed since the
 * last sync. -> { pulled, created, pushed_back, unchanged }. `afterChange(file)` runs for each file
 * the repo changed (the API passes the ICP / About us mirrors: afterRepoChange in
 * routes/api/context.mjs).
 */
export async function pullContextRepo(sb, cfg, { via = 'poll', afterChange = null } = {}) {
  const ws = cfg.workspace_id;
  const token = tokenOf(cfg);
  if (!token) throw new Error('The repo token cannot be read. Connect the repo again.');
  const base = clean(cfg.base_path);
  const prefix = base ? `${base}/` : '';
  const tree = (await fetchTree(token, cfg.github_repo, cfg.github_branch))
    .filter(t => t.type === 'blob' && t.path.startsWith(prefix) && /\.md$/i.test(t.path) && !t.path.slice(prefix.length).includes('/'))
    .slice(0, MAX_PULL);
  const { data: files, error } = await sb.from('workspace_context_files').select(SYNC_COLS).eq('workspace_id', ws).not('repo_path', 'is', null);
  if (error) throw error;
  const byPath = new Map((files ?? []).map(f => [f.repo_path, f]));
  const out = { pulled: 0, created: 0, pushed_back: 0, unchanged: 0 };
  const now = () => new Date().toISOString();
  for (const t of tree) {
    const file = byPath.get(t.path);
    if (file && file.git_sha === t.sha) { out.unchanged++; continue; }
    const text = (await fetchBlob(token, cfg.github_repo, t.sha)) ?? '';
    const c = await lastCommit(token, cfg, t.path);
    const note = c?.message || 'Edited in the repo';
    if (!file) {
      // A file someone added to the repo: a new context file, shared with the workspace.
      if (!cfg.connected_by) continue;
      const { data: made, error: e2 } = await sb.from('workspace_context_files').insert({
        workspace_id: ws, title: titleOf(t.path, text), kind: 'reference', body: text, visibility: 'workspace',
        created_by: cfg.connected_by, updated_by: cfg.connected_by, repo_path: t.path, git_sha: t.sha, repo_synced_at: now(),
      }).select(SYNC_COLS).single();
      if (e2) { console.warn('[context-repo] new file not added:', t.path, e2.message); continue; }
      await recordContextVersion(sb, ws, made, { kind: 'repo', name: c?.author?.name ?? null, changelog: `Added in the repo: ${note}`.slice(0, 200), gitSha: c?.sha ?? null });
      out.created++;
      continue;
    }
    if (text === (file.body ?? '')) {   // same text, new blob (e.g. our own commit read back)
      await sb.from('workspace_context_files').update({ git_sha: t.sha, repo_synced_at: now() }).eq('workspace_id', ws).eq('id', file.id);
      out.unchanged++;
      continue;
    }
    const appChanged = file.repo_synced_at && String(file.updated_at) > String(file.repo_synced_at);
    if (appChanged && latestWins({ appEditedAt: file.updated_at, repoCommittedAt: c?.at }) === 'app') {
      // Both changed; the app's edit is later. The repo's text is kept as a version, then ours goes back.
      await recordContextVersion(sb, ws, { ...file, body: text }, { kind: 'repo', name: c?.author?.name ?? null, changelog: `From the repo: ${note}`.slice(0, 200), gitSha: c?.sha ?? null });
      const sha = await putPath(token, cfg, t.path, file.body ?? '', { message: `${slugOf(file.title)}: kept the later edit from OpenNous`, author: OPENNOUS, sha: t.sha });
      await sb.from('workspace_context_files').update({ git_sha: sha, repo_synced_at: now() }).eq('workspace_id', ws).eq('id', file.id);
      out.pushed_back++;
      continue;
    }
    // The repo's edit is the latest: it becomes the file's text, as a version by its author.
    // One instant for both, so the file does not read as edited in the app after its own sync.
    const at = now();
    const { data: next, error: e3 } = await sb.from('workspace_context_files')
      .update({ body: text, git_sha: t.sha, repo_synced_at: at, updated_at: at })
      .eq('workspace_id', ws).eq('id', file.id).select(SYNC_COLS).single();
    if (e3) { console.warn('[context-repo] pull not applied:', t.path, e3.message); continue; }
    await recordContextVersion(sb, ws, next, { kind: 'repo', name: c?.author?.name ?? null, changelog: note, gitSha: c?.sha ?? null });
    await afterChange?.(next);
    out.pulled++;
  }
  await sb.from('workspace_context_repos').update({ sync_status: 'ok', last_error: null, last_synced_at: now(), last_synced_via: via, last_polled_at: now(), updated_at: now() }).eq('workspace_id', ws);
  return out;
}

/** Commit every shared file the repo does not have yet (after connecting). -> files pushed. */
export async function pushAllContextFiles(sb, ws, who) {
  const { data, error } = await sb.from('workspace_context_files').select('id, visibility, document_id, repo_path').eq('workspace_id', ws).is('repo_path', null);
  if (error) throw error;
  let n = 0;
  for (const f of (data ?? []).filter(syncable)) {
    if ((await pushContextFile(sb, ws, f.id, { who, changelog: 'Added from OpenNous' })).status === 'pushed') n++;
  }
  return n;
}

/**
 * Connect (or reconnect) the workspace's repo. Checks the token can see it, adds a push webhook
 * when the token may (else the poll carries it), saves the connection, then a first sync both ways.
 * -> the connection as repoOut shows it, plus what the first sync did.
 */
export async function connectContextRepo(sb, ws, uid, { repo, token, branch = null, base_path = 'Playbooks' }, { afterChange = null } = {}) {
  const name = String(repo ?? '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!token || !/^[^/\s]+\/[^/\s]+$/.test(name)) throw Object.assign(new Error('Give the repo as owner/name and a token.'), { status: 400 });
  let meta;
  try { meta = await validateRepo(String(token).trim(), name); }
  catch (e) { throw Object.assign(new Error(e.message), { status: 400 }); }
  const before = await loadContextRepo(sb, ws);
  if (before?.webhook_id) await deleteWebhook(tokenOf(before) ?? '', before.github_repo, before.webhook_id);
  const syncToken = crypto.randomBytes(24).toString('hex');
  const secret = crypto.randomBytes(24).toString('hex');
  const finalRepo = meta.full_name || name;
  const apiBase = publicApiBase();
  const webhookId = /^https:\/\//.test(apiBase) ? await registerWebhook(String(token).trim(), finalRepo, `${apiBase}/api/context-repo/webhook/${syncToken}`, secret) : null;
  const row = {
    workspace_id: ws, github_repo: finalRepo, github_branch: String(branch ?? '').trim() || meta.default_branch || 'main',
    base_path: clean(base_path) || 'Playbooks', github_token_enc: encryptValue(String(token).trim()),
    webhook_id: webhookId, webhook_secret: secret, sync_token: syncToken, auto_sync: true, sync_status: 'idle', last_error: null,
    connected_by: uid, updated_at: new Date().toISOString(),
  };
  const { data: saved, error } = await sb.from('workspace_context_repos').upsert(row, { onConflict: 'workspace_id' }).select(REPO_COLS).single();
  if (error) throw error;
  // A reconnect to another repo or folder starts the files' repo tracking over.
  if (before && (before.github_repo !== saved.github_repo || before.base_path !== saved.base_path || before.github_branch !== saved.github_branch)) {
    await sb.from('workspace_context_files').update({ repo_path: null, git_sha: null, repo_synced_at: null }).eq('workspace_id', ws);
  }
  const pulled = await pullContextRepo(sb, saved, { via: 'connect', afterChange });
  const pushed = await pushAllContextFiles(sb, ws, { kind: 'person', userId: uid });
  return { repo: repoOut(await loadContextRepo(sb, ws)), first_sync: { ...pulled, pushed } };
}

/** Disconnect: the webhook goes, the files stay in both places as they are. */
export async function disconnectContextRepo(sb, ws) {
  const cfg = await loadContextRepo(sb, ws);
  if (!cfg) return;
  if (cfg.webhook_id) await deleteWebhook(tokenOf(cfg) ?? '', cfg.github_repo, cfg.webhook_id);
  await sb.from('workspace_context_repos').delete().eq('workspace_id', ws);
  await sb.from('workspace_context_files').update({ repo_path: null, git_sha: null, repo_synced_at: null }).eq('workspace_id', ws);
}

/** Is this GitHub delivery signed by the connection's secret? Pure. */
export function signatureOk(secret, rawBody, header) {
  if (!secret || !header) return false;
  const mac = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return header.length === mac.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(mac));
}

/** The poll: every connection due (no webhook, or quiet for an hour), read once. */
export async function syncDueContextRepos(sb, { afterChange = null, now = Date.now() } = {}) {
  const { data, error } = await sb.from('workspace_context_repos').select(REPO_COLS).eq('auto_sync', true);
  if (error) { if (missing(error)) return { considered: 0, synced: 0 }; throw error; }
  let synced = 0;
  const due = (data ?? []).filter(r => !r.webhook_id || !r.last_synced_at || now - Date.parse(r.last_synced_at) > 3_600_000);
  for (const r of due) {
    try { await pullContextRepo(sb, r, { via: 'poll', afterChange: afterChange ? (f) => afterChange(r.workspace_id, f) : null }); synced++; }
    catch (e) {
      console.warn('[context-repo] poll failed:', r.github_repo, e?.message ?? e);
      await sb.from('workspace_context_repos').update({ sync_status: 'error', last_error: String(e?.message ?? e).slice(0, 300), last_polled_at: new Date().toISOString() }).eq('workspace_id', r.workspace_id);
    }
  }
  return { considered: due.length, synced };
}
