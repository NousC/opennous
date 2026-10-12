// GitHub sync for the personal workspace (Phase 2). The connected repo is canonical;
// we mirror its six foundation folders into personal_files and push edits back as
// commits. Only markdown under those folders is touched — everything else in the repo
// is ignored. Auth is a fine-grained PAT (Contents: read/write), encrypted at rest.
import { embedVaultRow } from './personalVault.mjs';
import { parseSkillFile } from './skillFile.mjs';
import { lintSkill, hasBlockingLint } from './skillLint.mjs';

// Default 7 + legacy folders still accepted for existing files (see personalVault.mjs).
const FOUNDATION_FOLDERS = ['inbox', 'projects', 'decisions', 'accounts', 'people', 'resources', 'archive', 'thoughts', 'briefs', 'content', 'company'];

const GH = 'https://api.github.com';
const SUBFOLDERS = { briefs: ['account-briefs', 'meeting-briefs'] };

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nous-personal-sync',
  };
}

const b64encode = (s) => Buffer.from(s, 'utf8').toString('base64');
const b64decode = (s) => Buffer.from(s, 'base64').toString('utf8');

// Does this source use a folder map (each vault folder sourced from an arbitrary
// repo path) rather than the old base_path/<folder> convention?
const hasMap = (folder_map) => folder_map && typeof folder_map === 'object' && Object.keys(folder_map).length > 0;

// Where a file lives in the repo. With a folder map, the vault folder's mapped repo
// path replaces <base_path>/<folder>; otherwise the old <base_path>/<folder> shape.
// Subfolder + name are preserved on top either way.
export function repoPath({ base_path, folder_map }, folder, subfolder, name) {
  const clean = (p) => String(p).replace(/^\/+|\/+$/g, '');
  if (hasMap(folder_map) && folder_map[folder]) {
    return [clean(folder_map[folder]), subfolder, name].filter(Boolean).map(clean).join('/');
  }
  const parts = [base_path, folder, subfolder, name].filter(Boolean).map(clean);
  return parts.join('/');
}

// Given a repo path relative to base_path, classify it into a foundation folder (or
// null if it is outside the vault and must be ignored). Old base_path convention.
function classify(relPath) {
  if (!relPath.endsWith('.md')) return null;
  const segs = relPath.split('/').filter(Boolean);
  const folder = segs[0];
  if (!FOUNDATION_FOLDERS.includes(folder)) return null;
  const subs = SUBFOLDERS[folder] || [];
  let subfolder = null;
  let nameStart = 1;
  if (subs.includes(segs[1])) { subfolder = segs[1]; nameStart = 2; }
  const name = segs.slice(nameStart).join('/');
  if (!name) return null;
  return { folder, subfolder, name };
}

// Reverse-map a FULL repo path (e.g. ops/people/theo/content/strategy/pov.md) to
// (vault folder, subfolder, name) using the folder map. The longest matching mapped
// path wins (most specific). One subfolder level; deeper nesting rides inside the name
// so path → parts → path round-trips — the same convention the local desk uses.
function classifyWithMap(fullPath, folderMap) {
  if (!fullPath.endsWith('.md')) return null;
  let best = null;
  for (const [folder, mapped] of Object.entries(folderMap)) {
    if (!mapped || !FOUNDATION_FOLDERS.includes(folder)) continue;
    const rp = String(mapped).replace(/^\/+|\/+$/g, '');
    if (rp && fullPath.startsWith(rp + '/') && (!best || rp.length > best.rp.length)) best = { folder, rp };
  }
  if (!best) return null;
  const segs = fullPath.slice(best.rp.length + 1).split('/').filter(Boolean);
  if (!segs.length) return null;
  if (segs.length === 1) return { folder: best.folder, subfolder: null, name: segs[0] };
  return { folder: best.folder, subfolder: segs[0], name: segs.slice(1).join('/') };
}

// Discover the repo's folders for the connect mapping step: which folders actually
// hold markdown (with a count), and a suggested vault→repo mapping (any md-holding
// folder whose basename matches a foundation folder, shallowest first). No writes.
export async function discoverFolders(cfg) {
  const tree = await fetchTree(cfg.token, cfg.repo, cfg.branch);
  // Count markdown AT OR BELOW every directory, so a PARENT folder is selectable too —
  // e.g. a `projects/` that only holds subfolders of .md should be mappable (mapping it
  // pulls the whole tree, subfolders preserved), not just the leaf dir that literally
  // contains the files.
  const dirCounts = new Map();
  for (const node of tree) {
    if (node.type !== 'blob' || !node.path.endsWith('.md')) continue;
    const parts = node.path.split('/').slice(0, -1);
    let acc = '';
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      dirCounts.set(acc, (dirCounts.get(acc) || 0) + 1);
    }
  }
  const folders = [...dirCounts.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path));
  const suggested = {};
  for (const f of FOUNDATION_FOLDERS) {
    const match = folders
      .filter((d) => d.path.split('/').pop().toLowerCase() === f)
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0];
    if (match) suggested[f] = match.path;
  }
  return { folders, suggested };
}

export async function validateRepo(token, repo) {
  const r = await fetch(`${GH}/repos/${repo}`, { headers: headers(token) });
  if (r.status === 404) throw new Error('Repo not found, or the token cannot see it.');
  if (r.status === 401 || r.status === 403) throw new Error('Token rejected. Give it Contents: read/write on this repo.');
  if (!r.ok) throw new Error(`GitHub error (${r.status}).`);
  const d = await r.json();
  return { default_branch: d.default_branch, full_name: d.full_name };
}

// Read the repo tree and diff it against the vault WITHOUT writing anything. This is
// the "scan" — it tells the member the exact workload before they decide to ingest.
// No blob contents are fetched here (the tree carries the shas), so it's cheap.
// Fetch the repo's recursive tree (blobs carry their shas, so a diff is cheap and
// no blob contents are read here). Shared by the vault scan and the skill scan.
export async function fetchTree(token, repo, branch) {
  const br = await fetch(`${GH}/repos/${repo}/branches/${encodeURIComponent(branch)}`, { headers: headers(token) });
  if (!br.ok) throw new Error(`Couldn't read branch "${branch}" (${br.status}).`);
  const treeSha = (await br.json())?.commit?.commit?.tree?.sha;
  const tr = await fetch(`${GH}/repos/${repo}/git/trees/${treeSha}?recursive=1`, { headers: headers(token) });
  if (!tr.ok) throw new Error(`Couldn't read the repo tree (${tr.status}).`);
  return (await tr.json())?.tree ?? [];
}

// The prefix a member's synced subtree lives under (base_path), '' for whole-repo.
const treePrefix = (base_path) => (base_path ? `${String(base_path).replace(/^\/+|\/+$/g, '')}/` : '');

// Where to look for skills in the repo. Skills live in `skills/` or `.claude/skills/`,
// anchored under the SAME subtree as the vault. Prefer base_path; but when a repo is
// wired by folder_map (base_path null) and every mapped folder sits under one top dir
// (e.g. everything under `ops/`), scan skills under that dir too — otherwise a
// folder-mapped repo silently never finds its skills (the exact bug on one of our own repos).
function skillScanPrefix(base_path, folder_map) {
  if (base_path) return treePrefix(base_path);
  const mapped = Object.values(folder_map || {}).filter(Boolean).map((p) => String(p).replace(/^\/+|\/+$/g, ''));
  if (!mapped.length) return '';
  const tops = mapped.map((p) => p.split('/')[0]);
  return tops.every((t) => t && t === tops[0]) ? `${tops[0]}/` : '';
}

// A skill file in the member's subtree: skills/<name>/SKILL.md, .claude/skills/<name>/SKILL.md,
// or a flat skills/<name>.md. Returns the skill's handle (its folder/file name) or null.
function classifySkillPath(rel) {
  let m = rel.match(/^(?:\.claude\/)?skills\/([^/]+)\/SKILL\.md$/i);
  if (m) return m[1];
  m = rel.match(/^(?:\.claude\/)?skills\/([^/]+)\.md$/i);
  if (m && m[1].toLowerCase() !== 'readme') return m[1];
  return null;
}

// A reference file bundled with a skill folder: skills/<handle>/references/<name>.md
// (or .claude/skills/…). Returns { handle, name } or null. This is what lets a member
// bring a whole sophisticated skill FOLDER — not just a lone SKILL.md — from GitHub.
function classifySkillReferencePath(rel) {
  const m = rel.match(/^(?:\.claude\/)?skills\/([^/]+)\/references\/([^/]+)\.md$/i);
  return m ? { handle: m[1], name: m[2] } : null;
}

// A runnable file in a skill folder: skills/<handle>/scripts/… or /assets/…, plus the
// root package.json / lockfile that declares its npm deps — the part that only a
// SANDBOX skill has. Returns { handle, path } (path relative to the skill folder, e.g.
// 'scripts/render.mjs' or 'package.json') or null. Presence of any script marks the
// skill as a sandbox skill.
function classifySkillFilePath(rel) {
  const m = rel.match(/^(?:\.claude\/)?skills\/([^/]+)\/((?:scripts|assets)\/.+|package\.json|package-lock\.json|npm-shrinkwrap\.json)$/i);
  return m ? { handle: m[1], path: m[2] } : null;
}

const toSkillList = (v) => (Array.isArray(v) ? v : (typeof v === 'string' && v ? [v] : []));

async function readPlan(supabase, workspaceId, userId, cfg) {
  const { token, repo, branch, base_path, folder_map } = cfg;
  const tree = await fetchTree(token, repo, branch);

  // Folder map: reverse-map each blob's FULL path to a vault folder. Otherwise the old
  // base_path convention (a file must sit under base_path/<foundation-folder>/…).
  const useMap = hasMap(folder_map);
  const prefix = treePrefix(base_path);
  const wanted = [];
  for (const node of tree) {
    if (node.type !== 'blob') continue;
    let cls;
    if (useMap) {
      cls = classifyWithMap(node.path, folder_map);
    } else {
      if (prefix && !node.path.startsWith(prefix)) continue;
      cls = classify(prefix ? node.path.slice(prefix.length) : node.path);
    }
    if (cls) wanted.push({ ...cls, sha: node.sha });
  }

  // Match against what the vault holds. Only git-sourced rows are eligible for
  // "removed" — a member's inbox drafts are never deleted by a scan.
  const { data: existing } = await supabase
    .from('personal_files')
    .select('id, folder, subfolder, name, git_sha, status, content')
    .eq('workspace_id', workspaceId).eq('user_id', userId);
  const byKey = new Map((existing ?? []).map((f) => [`${f.folder}/${f.subfolder ?? ''}/${f.name}`, f]));
  const seen = new Set();
  const added = [], changed = [];
  for (const w of wanted) {
    const key = `${w.folder}/${w.subfolder ?? ''}/${w.name}`;
    seen.add(key);
    const row = byKey.get(key);
    if (!row) added.push(w);
    // Carry the local status + content so ingest can tell a clean fast-forward from a
    // file the member has edited locally (which must not be silently overwritten).
    else if (row.git_sha !== w.sha) changed.push({ ...w, id: row.id, localStatus: row.status, localContent: row.content ?? '' });
  }
  const removed = [];
  for (const [key, row] of byKey) if (!seen.has(key) && row.git_sha) removed.push(row);
  return { added, changed, removed };
}

// Scan → the workload summary (counts per folder), nothing written.
export async function scanVault(supabase, workspaceId, userId, cfg) {
  const { added, changed, removed } = await readPlan(supabase, workspaceId, userId, cfg);
  const byFolder = {};
  const bump = (f, k) => { (byFolder[f] ??= { added: 0, changed: 0, removed: 0 })[k]++; };
  added.forEach((w) => bump(w.folder, 'added'));
  changed.forEach((w) => bump(w.folder, 'changed'));
  removed.forEach((w) => bump(w.folder, 'removed'));
  return {
    added: added.length, changed: changed.length, removed: removed.length,
    byFolder: Object.entries(byFolder).map(([folder, c]) => ({ folder, ...c })),
  };
}

// Ingest → apply the plan: fetch blobs for the new/changed files, write them, and
// delete the ones gone from the repo (the repo is canonical for git-sourced files).
export async function ingestVault(supabase, workspaceId, userId, cfg) {
  const { token, repo } = cfg;
  const { added, changed, removed } = await readPlan(supabase, workspaceId, userId, cfg);
  const now = () => new Date().toISOString();
  let pulled = 0, conflicts = 0;

  // New in the repo → new local file. Straightforward: nothing local to protect.
  for (const w of added) {
    const content = await fetchBlob(token, repo, w.sha);
    if (content == null) continue;
    const { data: ins } = await supabase.from('personal_files')
      .insert({
        workspace_id: workspaceId, user_id: userId,
        folder: w.folder, subfolder: w.subfolder, name: w.name,
        content, source: 'git', status: 'synced', git_sha: w.sha, created_by: userId, updated_at: now(),
      })
      .select('id, folder, subfolder, name, content').single();
    if (ins?.id) await embedVaultRow(supabase, ins);
    pulled++;
  }

  // Changed in the repo. Fast-forward a CLEAN local copy; STASH a conflict when the
  // member has local edits, so their work is never overwritten.
  for (const w of changed) {
    const content = await fetchBlob(token, repo, w.sha);
    if (content == null) continue;
    const clean = w.localStatus === 'synced';
    if (clean || content === w.localContent) {
      await supabase.from('personal_files')
        .update({ content, source: 'git', status: 'synced', git_sha: w.sha, conflict_content: null, conflict_sha: null, updated_at: now() })
        .eq('id', w.id);
      await embedVaultRow(supabase, { id: w.id, folder: w.folder, subfolder: w.subfolder, name: w.name, content });
      pulled++;
    } else {
      // Local edits differ from the incoming version → don't clobber. Stash theirs.
      await supabase.from('personal_files')
        .update({ status: 'conflict', conflict_content: content, conflict_sha: w.sha, updated_at: now() })
        .eq('id', w.id);
      conflicts++;
    }
  }

  // Gone from the repo. Delete a clean mirror; keep a locally-edited one as local-only
  // (deleting it would lose the member's unpushed work).
  let removedCount = 0;
  for (const row of removed) {
    if (row.status === 'synced') { await supabase.from('personal_files').delete().eq('id', row.id); removedCount++; }
    else await supabase.from('personal_files').update({ status: 'local_only', git_sha: null }).eq('id', row.id);
  }

  return { pulled, removed: removedCount, conflicts };
}

export async function fetchBlob(token, repo, sha) {
  const bl = await fetch(`${GH}/repos/${repo}/git/blobs/${sha}`, { headers: headers(token) });
  if (!bl.ok) return null;
  return b64decode((await bl.json())?.content ?? '');
}

// A skill's runnable files can be binary (a font, a template image), so read the
// blob as raw bytes rather than forcing utf8. Returns a Buffer or null.
async function fetchBlobRaw(token, repo, sha) {
  const bl = await fetch(`${GH}/repos/${repo}/git/blobs/${sha}`, { headers: headers(token) });
  if (!bl.ok) return null;
  return Buffer.from((await bl.json())?.content ?? '', 'base64');
}

// ── Webhooks — real-time inbound. A push to the connected repo/branch pings our
// receiver, which ingests the delta. Best-effort at connect time: a fine-grained
// PAT without the "Webhooks" permission simply returns null and the source relies
// on the poll fallback instead.
export async function registerWebhook(token, repo, callbackUrl, secret) {
  try {
    const r = await fetch(`${GH}/repos/${repo}/hooks`, {
      method: 'POST', headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'web', active: true, events: ['push'],
        config: { url: callbackUrl, content_type: 'json', secret, insecure_ssl: '0' },
      }),
    });
    if (!r.ok) return null;
    return (await r.json())?.id ?? null;
  } catch { return null; }
}

export async function deleteWebhook(token, repo, id) {
  if (!id) return;
  try {
    await fetch(`${GH}/repos/${repo}/hooks/${id}`, { method: 'DELETE', headers: headers(token) });
  } catch { /* best-effort — a stale hook just pings a source that no longer ingests */ }
}

// ── Conflict resolution. 'theirs' adopts the stashed remote version; 'mine' pushes
// the local content over the remote (using the stashed remote sha as the base so
// GitHub accepts the overwrite). Either way the conflict is cleared.
export async function resolveConflict(supabase, workspaceId, userId, fileId, keep, cfg) {
  const { data: row } = await supabase.from('personal_files')
    .select('*').eq('id', fileId).eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
  if (!row) return { error: 'not_found' };
  if (row.status !== 'conflict') return { error: 'not_in_conflict' };

  if (keep === 'theirs') {
    const fields = { content: row.conflict_content ?? '', source: 'git', status: 'synced', git_sha: row.conflict_sha, conflict_content: null, conflict_sha: null, updated_at: new Date().toISOString() };
    await supabase.from('personal_files').update(fields).eq('id', fileId);
    await embedVaultRow(supabase, { id: fileId, folder: row.folder, subfolder: row.subfolder, name: row.name, content: fields.content });
    return { resolved: 'theirs' };
  }

  // keep === 'mine' → push local content over the remote at the conflicting sha.
  try {
    const sha = await pushFile(cfg.token, cfg, { folder: row.folder, subfolder: row.subfolder, name: row.name, content: row.content, git_sha: row.conflict_sha });
    await supabase.from('personal_files')
      .update({ status: 'synced', git_sha: sha, conflict_content: null, conflict_sha: null, updated_at: new Date().toISOString() })
      .eq('id', fileId);
    return { resolved: 'mine' };
  } catch (e) {
    return { error: e.message === 'conflict' ? 'remote_moved_again' : 'push_failed' };
  }
}

// ── Skills from the repo (Layer D part 2). A member can author agent skills the way
// they author their vault: a skills/<name>/SKILL.md (or .claude/skills/…) in their
// connected subtree. On ingest we mirror each into workspace_skills as a PRIVATE,
// git-sourced skill they own — the same rows the editor and the agent already read.
//
// The skill's handle is its folder/file name, so matching is deterministic. Ownership
// is respected: if the member later edits a git skill in the editor (which flips its
// source to 'manual'), the repo never overwrites it again. A git skill that vanishes
// from the repo is removed; a manual one is never touched.
export async function ingestRepoSkills(supabase, workspaceId, userId, cfg) {
  if (!userId) return { pulled: 0, removed: 0, refs: 0, skipped: [] };
  const { token, repo, branch, base_path, folder_map } = cfg;
  const tree = await fetchTree(token, repo, branch);
  // Skills live under the same subtree as the vault; when the repo is wired by
  // folder_map (base_path null), derive the subtree so its skills are actually found.
  const prefix = skillScanPrefix(base_path, folder_map);

  const wanted = new Map();       // handle → sha (the SKILL.md)
  const wantedRefs = new Map();   // handle → Map(refName → sha)
  const wantedFiles = new Map();  // handle → Map(path → sha)  — scripts/ + assets/ (sandbox)
  for (const node of tree) {
    if (node.type !== 'blob') continue;
    if (prefix && !node.path.startsWith(prefix)) continue;
    const rel = prefix ? node.path.slice(prefix.length) : node.path;
    const handle = classifySkillPath(rel);
    if (handle) { wanted.set(handle, node.sha); continue; }
    const ref = classifySkillReferencePath(rel);
    if (ref) {
      if (!wantedRefs.has(ref.handle)) wantedRefs.set(ref.handle, new Map());
      wantedRefs.get(ref.handle).set(ref.name, node.sha);
      continue;
    }
    const file = classifySkillFilePath(rel);
    if (file) {
      if (!wantedFiles.has(file.handle)) wantedFiles.set(file.handle, new Map());
      wantedFiles.get(file.handle).set(file.path, node.sha);
    }
  }

  // Everything this member owns, so we can match by name and honour manual ownership.
  const { data: mine } = await supabase.from('workspace_skills')
    .select('id, name, source, git_sha')
    .eq('workspace_id', workspaceId).eq('created_by', userId);
  const byName = new Map((mine ?? []).map((s) => [s.name, s]));
  // Built-in names, so we don't silently import a skill that shadows a native one.
  const { data: builtins } = await supabase.from('workspace_skills').select('name').is('workspace_id', null);
  const builtinNames = (builtins ?? []).map((b) => b.name);

  let pulled = 0;
  const skipped = [];   // { name, reasons } — surfaced so a blocked import is never silent
  for (const [handle, sha] of wanted) {
    const existing = byName.get(handle);
    if (existing && existing.source !== 'git') continue;   // member took ownership — leave it
    if (existing && existing.git_sha === sha) continue;    // unchanged
    const blob = await fetchBlob(token, repo, sha);
    if (blob == null) continue;
    const { meta, body } = parseSkillFile(blob);
    if (!meta.description || !body) { skipped.push({ name: handle, reasons: ['needs a description and a body'] }); continue; }
    // Which lane? A skill with a scripts/ folder, or an explicit `runtime: sandbox`,
    // is a sandbox skill — it runs in a container, so shell/scripts are expected and
    // the linter routes rather than blocks. Everything else is a tool skill.
    const hasScripts = [...(wantedFiles.get(handle)?.keys() ?? [])].some((p) => p.startsWith('scripts/'));
    const runtime = (meta.runtime === 'sandbox' || hasScripts) ? 'sandbox' : 'tool';
    // Compatibility gate: only import a skill that will actually RUN in its lane. A
    // tool skill with shell/scripts, or either lane shadowing a native, is skipped
    // with its reasons — not silently pulled in to fail later.
    const refNames = [...(wantedRefs.get(handle)?.keys() ?? [])];
    const lint = lintSkill({ name: handle, body, allowedTools: toSkillList(meta['allowed-tools']), referenceNames: refNames, builtinNames, runtime });
    if (hasBlockingLint(lint)) { skipped.push({ name: handle, reasons: lint.filter((w) => w.level === 'error').map((w) => w.code) }); continue; }
    const row = {
      workspace_id: workspaceId, created_by: userId,
      name: handle,
      description: String(meta.description),
      summary: meta.summary ? String(meta.summary) : null,
      body,
      category: meta.category ? String(meta.category) : null,
      requires_providers: toSkillList(meta['requires-providers']),
      allowed_tools: toSkillList(meta['allowed-tools']),
      est_cost_usd: typeof meta['est-cost-usd'] === 'number' ? meta['est-cost-usd'] : null,
      runtime,
      entrypoint: meta.entrypoint ? String(meta.entrypoint) : null,
      required_secrets: toSkillList(meta['secrets'] ?? meta['requires-secrets']).map((s) => String(s).trim().toUpperCase()),
      egress_hosts: toSkillList(meta['egress'] ?? meta['allow-hosts']).map((h) => String(h).trim().toLowerCase()),
      visibility: 'private', source: 'git', git_sha: sha, is_builtin: false, enabled: true,
      updated_at: new Date().toISOString(),
    };
    if (existing) await supabase.from('workspace_skills').update(row).eq('id', existing.id);
    else {
      const { data: ins, error } = await supabase.from('workspace_skills').insert(row).select('id').single();
      if (error) continue;   // e.g. collides with a manual skill of the same name — leave that one
      byName.set(handle, { id: ins.id, name: handle, source: 'git', git_sha: sha }); // so its refs find the id
    }
    pulled++;
  }

  // References/ for each git skill (Layer D part 3) — the whole folder, not just the
  // SKILL.md. Runs independent of the change-check above, so a reference-only edit still
  // syncs; each reference tracks its own git sha. Only touches git-owned skills.
  let refs = 0;
  for (const [handle, refMap] of wantedRefs) {
    const skill = byName.get(handle);
    if (!skill?.id || skill.source !== 'git') continue;    // no such git skill, or member owns it manually
    const { data: existingRefs } = await supabase.from('workspace_skill_references')
      .select('id, name, git_sha').eq('skill_id', skill.id);
    const existingByName = new Map((existingRefs ?? []).map((r) => [r.name, r]));
    for (const [refName, refSha] of refMap) {
      const ex = existingByName.get(refName);
      if (ex && ex.git_sha === refSha) continue;           // unchanged
      const blob = await fetchBlob(token, repo, refSha);
      if (blob == null || !blob.trim()) continue;
      const fields = { content: blob.trim(), git_sha: refSha, updated_at: new Date().toISOString() };
      if (ex) await supabase.from('workspace_skill_references').update(fields).eq('id', ex.id);
      else await supabase.from('workspace_skill_references').insert({ skill_id: skill.id, name: refName, ...fields });
      refs++;
    }
    // Drop git-sourced references removed from the repo (leave editor-added ones, which
    // carry no git_sha).
    for (const r of existingRefs ?? []) {
      if (r.git_sha != null && !refMap.has(r.name)) await supabase.from('workspace_skill_references').delete().eq('id', r.id);
    }
  }

  // scripts/ + assets/ for each git sandbox skill — the runnable folder the executor
  // materializes. Same git-sha change-check + drop-on-removal as references. Binary
  // assets are stored base64 (is_binary), scripts get the executable bit.
  let files = 0;
  for (const [handle, fileMap] of wantedFiles) {
    const skill = byName.get(handle);
    if (!skill?.id || skill.source !== 'git') continue;
    const { data: existingFiles } = await supabase.from('workspace_skill_files')
      .select('id, path, git_sha').eq('skill_id', skill.id);
    const existingByPath = new Map((existingFiles ?? []).map((f) => [f.path, f]));
    for (const [path, fileSha] of fileMap) {
      const ex = existingByPath.get(path);
      if (ex && ex.git_sha === fileSha) continue;            // unchanged
      const raw = await fetchBlobRaw(token, repo, fileSha);
      if (raw == null) continue;
      const isBinary = raw.includes(0);
      const content = isBinary ? raw.toString('base64') : raw.toString('utf8');
      const fields = { content, is_binary: isBinary, executable: path.startsWith('scripts/'), git_sha: fileSha, updated_at: new Date().toISOString() };
      if (ex) await supabase.from('workspace_skill_files').update(fields).eq('id', ex.id);
      else await supabase.from('workspace_skill_files').insert({ skill_id: skill.id, path, ...fields });
      files++;
    }
    // Drop git-sourced files removed from the repo (leave editor-added ones).
    for (const f of existingFiles ?? []) {
      if (f.git_sha != null && !fileMap.has(f.path)) await supabase.from('workspace_skill_files').delete().eq('id', f.id);
    }
  }

  let removed = 0;
  for (const s of mine ?? []) {
    if (s.source === 'git' && !wanted.has(s.name)) {
      await supabase.from('workspace_skills').delete().eq('id', s.id);   // FK cascade drops its references + files
      removed++;
    }
  }
  return { pulled, removed, refs, files, skipped };
}

// Push one file to the repo (create or update), returning the new blob sha.
export async function pushFile(token, cfg, file) {
  const path = repoPath(cfg, file.folder, file.subfolder, file.name);
  const body = {
    message: `nous: update ${path}`,
    content: b64encode(file.content ?? ''),
    branch: cfg.branch,
  };
  if (file.git_sha) body.sha = file.git_sha;
  const r = await fetch(`${GH}/repos/${cfg.repo}/contents/${path}`, {
    method: 'PUT', headers: { ...headers(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (r.status === 409) throw new Error('conflict'); // remote moved under us
  if (!r.ok) throw new Error(`push failed (${r.status})`);
  const d = await r.json();
  return d?.content?.sha ?? null;
}

// ── Connect-time evidence backfill ──────────────────────────────────────────────
// The live evidence push is WRITE-triggered (each new touch pushes itself). So without
// this, connecting a repo AFTER evidence already exists would never send the history —
// it would sit in Nous forever. This pushes ALL existing account/people evidence into a
// newly connected repo in ONE commit (Git Trees API), so connect is order-independent:
// connect the repo whenever, and the whole nous/accounts + nous/people history lands at
// once (GitHub auto-creates the folders). Best-effort — the source is already saved, so a
// failure just means "reconnect to re-run it".
export async function backfillEvidenceToRepo(supabase, cfg, workspaceId, userId) {
  const token = cfg.token;
  const repo = cfg.repo || cfg.github_repo;
  const branch = cfg.branch || cfg.github_branch || 'main';
  const base_path = cfg.base_path ?? null;
  if (!token || !repo) return { pushed: 0, reason: 'no_repo' };
  const clean = (p) => String(p ?? '').replace(/^\/+|\/+$/g, '');
  const NOUS_DIR = 'nous';

  const { data: rows } = await supabase.from('personal_files')
    .select('id, folder, subfolder, name, content')
    .eq('workspace_id', workspaceId).eq('user_id', userId)
    .in('folder', ['accounts', 'people']);
  if (!rows?.length) return { pushed: 0, reason: 'nothing_to_backfill' };

  const gh = async (method, path, body) => {
    const r = await fetch(`${GH}${path}`, { method, headers: { ...headers(token), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`github ${method} ${path.split('?')[0]} ${r.status}`);
    return r.json();
  };

  // Base commit + its tree, then one new tree that overlays every evidence file (base_tree
  // preserves everything else in the repo), then a commit and a fast-forward of the branch.
  const ref = await gh('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const baseSha = ref.object.sha;
  const baseCommit = await gh('GET', `/repos/${repo}/git/commits/${baseSha}`);
  const tree = rows.map((r) => ({
    path: [clean(base_path), NOUS_DIR, r.folder, clean(r.subfolder), r.name].filter(Boolean).join('/'),
    mode: '100644', type: 'blob', content: r.content ?? '',
  }));
  const newTree = await gh('POST', `/repos/${repo}/git/trees`, { base_tree: baseCommit.tree.sha, tree });
  const commit = await gh('POST', `/repos/${repo}/git/commits`, {
    message: `nous: backfill account & people evidence (${rows.length} files)`, tree: newTree.sha, parents: [baseSha],
  });
  await gh('PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha });
  // Clear per-file git_sha so the next live single-file push re-resolves the sha cleanly
  // (the tree commit changed every blob sha; the live pusher self-heals on 409/422).
  await supabase.from('personal_files').update({ git_sha: null })
    .eq('workspace_id', workspaceId).eq('user_id', userId).in('folder', ['accounts', 'people']);
  return { pushed: rows.length, commit: commit.sha };
}
