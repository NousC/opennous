// Workspace context library (GET-875), Settings > Knowledge. Context is saved once for the workspace
// (workspace_context_files), with every version of it (workspace_context_file_versions, GET-1038).
// Open source since 2026-10-29: it was Cloud's, with RevBoxes.
//
// Who sees a file:
//   - visibility 'workspace': every workspace member;
//   - visibility 'boxes' (the default): its creator, and on Cloud the people who can open a RevBox
//     it is tagged to. Without RevBoxes (the open-source build) nothing is tagged, so it is the
//     creator's alone: "Private" in the app.
// RevBox tags are Cloud's (revbox_context_links, @nous/core/cloud revboxes/contextLibrary.mjs): it
// registers them with registerContextBoxes, and every read and write here asks them through it.
// A file that is a linked document is also subject to the document's own visibility, which the API
// checks on read.
// The ICP file (kind 'icp', at most one per workspace, always 'workspace') is what ICP scoring reads:
// see workspaceIcpContext. The About us file (kind 'about',
// GET-1036) follows the same rules: who we are and what we have, read wherever the system needs to
// know what we sell (the API mirrors it into the workspace's positioning foundation).

export const CONTEXT_KINDS = ['reference', 'instructions', 'icp', 'about'];
// The designated files: one each per workspace, shared with the workspace, admins only. The
// visibility_before_icp and icp_marked_at columns serve both.
export const MARKED_KINDS = ['icp', 'about'];
const MARK_NAME = { icp: 'ICP', about: 'About us' };
const marked = (kind) => MARKED_KINDS.includes(kind);
export const CONTEXT_VISIBILITY = ['boxes', 'workspace'];
const MAX_BODY = 262144;
const FILE_COLS = 'id, workspace_id, title, kind, body, document_id, visibility, visibility_before_icp, created_by, updated_by, icp_marked_at, created_at, updated_at';
const VERSION_COLS = 'id, file_id, title, kind, body, author_kind, author_user_id, author_name, changelog, git_sha, created_at';
const CHANGELOG_MAX = 200;

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
async function rows(q) { const { data, error } = await q; if (error) throw error; return data ?? []; }
async function one(q) { const { data, error } = await q; if (error) throw error; return data; }
const now = () => new Date().toISOString();
const clean = (s, n) => typeof s === 'string' ? s.trim().slice(0, n) : '';
/** The library tables are not there yet (migration not applied): callers fall back to revbox_context. */
export const missingLibrary = (e) => ['42P01', 'PGRST205'].includes(e?.code) || /workspace_context_files|revbox_context_links/.test(e?.message ?? '') && /schema cache|does not exist/.test(e?.message ?? '');
const uniqueViolation = (e) => e?.code === '23505';

async function workspaceRole(sb, ws, uid) {
  const m = await one(sb.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', uid).maybeSingle());
  if (!m) fail(403, 'You are not a member of this workspace.');
  return m.role;
}
const isAdmin = (role) => role === 'owner' || role === 'admin';

/**
 * Can this viewer see the file? `visibleBoxIds`: the boxes the viewer can open; `links`: the file's
 * revbox ids. Pure.
 */
export function contextFileVisible(file, uid, visibleBoxIds, links) {
  if (!file || !uid) return false;
  if (file.visibility === 'workspace' || file.created_by === uid) return true;
  return links.some(id => visibleBoxIds.has(id));
}

/**
 * Can this viewer change the file's title, text and visibility, or delete it (GET-875)?
 *   - The ICP file drives workspace-wide scoring: a workspace owner/admin only, even for its creator.
 *   - Otherwise its creator, or a workspace owner/admin who can see it, or someone who can edit EVERY
 *     box it is tagged to (an editor of one box must not change what another box's runs read, nor
 *     share a file from a box they cannot see). Pure.
 */
export function contextFileEditable(file, uid, role, boxAccess, links) {
  if (!file || !uid) return false;
  const admin = isAdmin(role) && contextFileVisible(file, uid, new Set(boxAccess.keys()), links);
  if (marked(file.kind)) return admin;
  if (file.created_by === uid || admin) return true;
  return links.length > 0 && links.every(id => ['owner', 'editor'].includes(boxAccess.get(id)));
}

/** A library request body, validated. -> error message or null. Pure. */
export function validateContextFile(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid context file.';
  const keys = ['title', 'body', 'kind', 'visibility', 'document_id', 'revbox_ids', 'changelog'];
  if (Object.keys(body).some(k => !keys.includes(k))) return 'Unsupported context file field.';
  if ((!partial || 'title' in body) && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200)) return 'Give the file a title of up to 200 characters.';
  if ('body' in body && (typeof body.body !== 'string' || Buffer.byteLength(body.body) > MAX_BODY)) return 'Write or upload text up to 256 KB.';
  if ('kind' in body && !CONTEXT_KINDS.includes(body.kind)) return 'Choose reference, instructions, ICP or About us.';
  if ('visibility' in body && !CONTEXT_VISIBILITY.includes(body.visibility)) return 'Choose who can see this file.';
  if ('document_id' in body && body.document_id != null && typeof body.document_id !== 'string') return 'Choose a valid document.';
  if ('revbox_ids' in body && (!Array.isArray(body.revbox_ids) || body.revbox_ids.length > 100 || body.revbox_ids.some(id => typeof id !== 'string'))) return 'Choose valid RevBoxes.';
  if ('changelog' in body && body.changelog != null && (typeof body.changelog !== 'string' || body.changelog.length > CHANGELOG_MAX)) return `Keep the change note to ${CHANGELOG_MAX} characters.`;
  return null;
}

// ── RevBox tags (2026-10-29) ────────────────────────────────────────────────
// Cloud registers its RevBoxes here: { viewerBoxes(sb, ws, uid) -> { boxes, access }, linksOf(sb, ws,
// fileIds) -> [{ revbox_id, context_file_id, created_at }], retag(sb, ws, uid, fileId, current,
// access, wanted) -> box ids, dropped(sb, ws, fileId) }. Unregistered, no file has a box.
let BOXES = null;
/** Cloud's RevBoxes as the library's tags (its revboxes/contextLibrary.mjs, on import). */
export function registerContextBoxes(impl) { BOXES = impl ?? null; }

/** The viewer's boxes and access: Map(id -> 'owner'|'editor'|'viewer') plus the rows. */
async function viewerBoxes(sb, ws, uid) {
  return BOXES ? BOXES.viewerBoxes(sb, ws, uid) : { boxes: [], access: new Map() };
}
async function linksOf(sb, ws, fileIds = null) {
  if (!BOXES) return [];
  return BOXES.linksOf(sb, ws, fileIds);
}
/** Tag/untag the file so it is on exactly `wanted` among the boxes the viewer can open. Without
 *  boxes there is nothing to tag it to. */
async function retag(sb, ws, uid, fileId, current, access, wanted) {
  if (BOXES) return BOXES.retag(sb, ws, uid, fileId, current, access, wanted);
  if (wanted.length) fail(404, 'RevBox not found.');
  return current;
}
const linkMap = (links) => { const m = new Map(); for (const l of links) { if (!m.has(l.context_file_id)) m.set(l.context_file_id, []); m.get(l.context_file_id).push(l.revbox_id); } return m; };

/** A file row as the API returns it, with the viewer's tags (hidden boxes only counted). */
export function contextFileOut(f, boxIds, access, boxes, uid, role) {
  const names = new Map(boxes.map(b => [b.id, b]));
  const seen = boxIds.filter(id => access.has(id));
  return {
    id: f.id, title: f.title, kind: f.kind, body: f.body ?? '', document_id: f.document_id ?? null, visibility: f.visibility,
    created_by: f.created_by, created_at: f.created_at, updated_at: f.updated_at, icp_marked_at: f.icp_marked_at ?? null,
    boxes: seen.map(id => ({ id, name: names.get(id)?.name ?? 'RevBox', shared: !!names.get(id)?.shared })),
    hidden_boxes: boxIds.length - seen.length,
    can_edit: contextFileEditable(f, uid, role, access, boxIds),
  };
}

/**
 * Settings > Context: every file the viewer may see, newest first, with the boxes it is tagged to,
 * plus the viewer's boxes (for the tag picker and the per-box instruction blocks).
 * -> { files, boxes: [{ id, name, shared, access, blocks }], is_admin }
 */
export async function listContextLibrary(sb, ws, uid) {
  const role = await workspaceRole(sb, ws, uid);
  const { boxes, access } = await viewerBoxes(sb, ws, uid);
  const files = await rows(sb.from('workspace_context_files').select(FILE_COLS).eq('workspace_id', ws).order('updated_at', { ascending: false }).limit(1000));
  // The tags of the listed files only, in pages (a workspace-wide read could hit the row cap).
  const links = [];
  for (let i = 0; i < files.length; i += 200) links.push(...await linksOf(sb, ws, files.slice(i, i + 200).map(f => f.id)));
  const byFile = linkMap(links);
  const visibleIds = new Set(access.keys());
  const out = files.filter(f => contextFileVisible(f, uid, visibleIds, byFile.get(f.id) ?? []))
    .map(f => contextFileOut(f, byFile.get(f.id) ?? [], access, boxes, uid, role));
  return { files: out, boxes: boxes.map(b => ({ id: b.id, name: b.name, shared: !!b.shared, access: b.access, blocks: Array.isArray(b.blocks) ? b.blocks : [] })), is_admin: isAdmin(role) };
}

/** The file as this viewer may see it, with its links and the viewer's role/box access. 404 otherwise. */
export async function loadContextFile(sb, ws, uid, fileId) {
  const role = await workspaceRole(sb, ws, uid);
  const file = await one(sb.from('workspace_context_files').select(FILE_COLS).eq('workspace_id', ws).eq('id', fileId).maybeSingle());
  const { boxes, access } = await viewerBoxes(sb, ws, uid);
  const links = file ? (await linksOf(sb, ws, [file.id])).map(l => l.revbox_id) : [];
  if (!file || !contextFileVisible(file, uid, new Set(access.keys()), links)) fail(404, 'Context file not found.');
  return { file, links, role, access, boxes };
}

/** Make `fileId` the workspace's ICP or About us file (`kind`), or a plain reference again (null).
 *  Owners/admins only. */
async function setMark(sb, ws, uid, role, file, kind) {
  const name = MARK_NAME[kind ?? file.kind] ?? 'ICP';
  if (!isAdmin(role)) fail(403, `Only a workspace owner or admin can choose the ${name} file.`);
  if (kind && file.kind === kind) return file;
  if (!kind && !marked(file.kind)) return file;
  // Marking shares the file with the workspace; unmarking puts back the visibility it had before. A
  // file moving from one mark to the other keeps the visibility it had before the first.
  const before = marked(file.kind) ? file.visibility_before_icp : file.visibility;
  const patch = kind ? { kind, visibility: 'workspace', visibility_before_icp: before, icp_marked_at: now(), updated_by: uid, updated_at: now() }
    : { kind: 'reference', visibility: file.visibility_before_icp ?? file.visibility, visibility_before_icp: null, icp_marked_at: null, updated_by: uid, updated_at: now() };
  try {
    return await one(sb.from('workspace_context_files').update(patch).eq('workspace_id', ws).eq('id', file.id).select(FILE_COLS).single());
  } catch (e) {
    if (uniqueViolation(e)) fail(409, `This workspace already has an ${name} file. Unmark it first.`);
    throw e;
  }
}

/**
 * Add knowledge to the library: { title, body | document_id, kind?, visibility?, revbox_ids? }.
 * The API resolves a document_id to a document the viewer may read first. -> the file as listed.
 */
export async function createContextFile(sb, ws, uid, body) {
  const error = validateContextFile(body); if (error) fail(400, error);
  const role = await workspaceRole(sb, ws, uid);
  const { boxes, access } = await viewerBoxes(sb, ws, uid);
  const wanted = [...new Set(body.revbox_ids ?? [])];
  for (const id of wanted) { if (!access.has(id)) fail(404, 'RevBox not found.'); if (!['owner', 'editor'].includes(access.get(id))) fail(403, 'Only an owner or editor of a RevBox can change its context.'); }
  const kind = body.kind ?? 'reference';
  if (marked(kind) && !isAdmin(role)) fail(403, `Only a workspace owner or admin can choose the ${MARK_NAME[kind]} file.`);
  const visibility = body.visibility ?? 'boxes';
  // An ICP file is inserted as the ICP: the one-per-workspace index refuses a second one before
  // anything is written (no orphan row, no tags).
  const row = {
    workspace_id: ws, created_by: uid, updated_by: uid, title: clean(body.title, 200), kind,
    body: body.document_id ? '' : (body.body ?? ''), document_id: body.document_id ?? null,
    ...(marked(kind) ? { visibility: 'workspace', visibility_before_icp: visibility, icp_marked_at: now() } : { visibility }),
  };
  let file;
  try { file = await one(sb.from('workspace_context_files').insert(row).select(FILE_COLS).single()); }
  catch (e) { if (uniqueViolation(e)) fail(409, `This workspace already has an ${MARK_NAME[kind] ?? 'ICP'} file. Unmark it first.`); throw e; }
  const links = await retag(sb, ws, uid, file.id, [], access, wanted);
  await recordContextVersion(sb, ws, file, { kind: 'person', userId: uid, changelog: clean(body.changelog, CHANGELOG_MAX) || 'Created' });
  return contextFileOut(file, links, access, boxes, uid, role);
}

/** Edit a file: { title?, body?, kind?, visibility?, revbox_ids? }. kind 'icp' or 'about' marks it. */
export async function updateContextFile(sb, ws, uid, fileId, body) {
  const error = validateContextFile(body, { partial: true }); if (error) fail(400, error);
  let { file, links, role, access, boxes } = await loadContextFile(sb, ws, uid, fileId);
  const content = ['title', 'body', 'visibility'].some(k => k in body) || ('kind' in body && !marked(body.kind) && !marked(file.kind));
  if (content && !contextFileEditable(file, uid, role, access, links)) fail(403, 'You cannot change this file.');
  if ('document_id' in body && body.document_id !== file.document_id) fail(400, 'A linked document cannot be swapped. Add it as a new file.');
  if (file.document_id && 'body' in body) fail(400, 'This file is a linked document. Edit the document itself.');
  if (marked(file.kind) && body.visibility === 'boxes') fail(400, `The ${MARK_NAME[file.kind]} file is shared with the workspace. Unmark it first.`);
  const kindBefore = file.kind;
  if ('kind' in body && body.kind !== file.kind && (marked(body.kind) || marked(file.kind))) file = await setMark(sb, ws, uid, role, file, marked(body.kind) ? body.kind : null);
  const patch = {};
  if ('title' in body) patch.title = clean(body.title, 200);
  if ('body' in body) patch.body = body.body;
  if ('visibility' in body) patch.visibility = body.visibility;
  if ('kind' in body && !marked(body.kind)) patch.kind = body.kind;
  const before = { title: file.title, body: file.body };
  if (Object.keys(patch).length) file = await one(sb.from('workspace_context_files').update({ ...patch, updated_by: uid, updated_at: now() }).eq('workspace_id', ws).eq('id', file.id).select(FILE_COLS).single());
  if ('revbox_ids' in body) links = await retag(sb, ws, uid, file.id, links, access, [...new Set(body.revbox_ids)]);
  // A version for every change to what the file says, or to what it is (marked ICP / About us).
  const changed = file.title !== before.title || file.body !== before.body;
  const remarked = file.kind !== kindBefore;
  if (changed || remarked) {
    const note = clean(body.changelog, CHANGELOG_MAX) || (remarked && !changed ? (marked(file.kind) ? `Marked as ${MARK_NAME[file.kind]}` : `No longer the ${MARK_NAME[kindBefore] ?? kindBefore} file`) : null);
    await recordContextVersion(sb, ws, file, { kind: 'person', userId: uid, changelog: note });
  }
  return contextFileOut(file, links, access, boxes, uid, role);
}

/** Delete a file everywhere (every tag, and on Cloud its legacy box copies). Its creator or a workspace owner/admin. */
export async function deleteContextFile(sb, ws, uid, fileId) {
  const { file, role } = await loadContextFile(sb, ws, uid, fileId);
  if (marked(file.kind) ? !isAdmin(role) : (file.created_by !== uid && !isAdmin(role))) fail(403, marked(file.kind) ? `Only a workspace owner or admin can delete the ${MARK_NAME[file.kind]} file.` : 'Only the person who added this file or a workspace admin can delete it.');
  // The history outlives the file: its last text is kept as a version.
  await recordContextVersion(sb, ws, file, { kind: 'person', userId: uid, changelog: 'Deleted' });
  await rows(sb.from('workspace_context_files').delete().eq('workspace_id', ws).eq('id', file.id));
  await BOXES?.dropped?.(sb, ws, file.id);
}

// ── Versions (GET-1038) ──────────────────────────────────────────────────────
//
// Every change to a file's title or text keeps the text it now has, with who wrote it — a person, OpenNous
// (a living file it keeps current), or an edit pulled from the company repo (GET-1037) — and a one-line
// changelog. Restoring a version is itself a new version, so nothing is ever lost.

/** Keep `file` as it now is as a version. Best-effort: a missing table or a failed write never fails the
 *  save it records. author: { kind: 'person'|'opennous'|'repo', userId?, name?, changelog?, gitSha?, basedOn? }. */
export async function recordContextVersion(sb, ws, file, author = {}) {
  const row = {
    workspace_id: ws, file_id: file.id, title: file.title, kind: file.kind, body: file.body ?? '',
    author_kind: author.kind ?? 'person', author_user_id: author.userId ?? null, author_name: author.name ?? null,
    changelog: author.changelog ? String(author.changelog).slice(0, CHANGELOG_MAX) : null, git_sha: author.gitSha ?? null,
  };
  // GET-1054: an Intelligence update records what it read (author.basedOn: { deals } or { claims }).
  // Only sent when there is one, and dropped on retry if the based_on column is not migrated yet.
  try {
    try { await rows(sb.from('workspace_context_file_versions').insert(author.basedOn ? { ...row, based_on: author.basedOn } : row)); }
    catch (e) { if (!author.basedOn || !/based_on/.test(e?.message ?? '')) throw e; await rows(sb.from('workspace_context_file_versions').insert(row)); }
  } catch (e) {
    if (!/workspace_context_file_versions/.test(e?.message ?? '') && !['42P01', 'PGRST205'].includes(e?.code)) console.warn('[context-versions] not recorded:', e?.message ?? e);
  }
}

/** A file's versions, newest first, for a viewer who can see the file; each with its author's name. */
export async function listContextVersions(sb, ws, uid, fileId) {
  const { file } = await loadContextFile(sb, ws, uid, fileId);
  let versions;
  try { versions = await rows(sb.from('workspace_context_file_versions').select(VERSION_COLS).eq('workspace_id', ws).eq('file_id', file.id).order('created_at', { ascending: false }).limit(100)); }
  catch (e) { if (['42P01', 'PGRST205'].includes(e?.code) || /workspace_context_file_versions/.test(e?.message ?? '')) return []; throw e; }
  const ids = [...new Set(versions.map(v => v.author_user_id).filter(Boolean))];
  const users = ids.length ? await rows(sb.from('users').select('id, name, email').in('id', ids)) : [];
  const nameOf = new Map(users.map(u => [u.id, u.name || u.email || null]));
  return versions.map(v => ({
    ...v,
    author: v.author_kind === 'opennous' ? 'OpenNous' : (v.author_user_id && nameOf.get(v.author_user_id)) || v.author_name || (v.author_kind === 'repo' ? 'Repo' : 'Someone'),
  }));
}

/** Put a version's title and text back. The restore is a new version, so the text it replaces is kept too. */
export async function restoreContextVersion(sb, ws, uid, fileId, versionId) {
  const { file } = await loadContextFile(sb, ws, uid, fileId);
  const v = await one(sb.from('workspace_context_file_versions').select(VERSION_COLS).eq('workspace_id', ws).eq('file_id', file.id).eq('id', versionId).maybeSingle());
  if (!v) fail(404, 'Version not found.');
  if (file.document_id) fail(400, 'This file is a linked document. Restore it in the document itself.');
  const day = String(v.created_at ?? '').slice(0, 10);
  return updateContextFile(sb, ws, uid, file.id, { title: v.title, body: v.body, changelog: `Restored the version of ${day}` });
}

/**
 * The workspace's ICP file as text for ICP scoring: { id, title, text, updated_at } or null (none
 * marked, the library not migrated, or a linked document that was deleted). A linked document's text
 * is its current body. Workspace-level by design: the ICP file is always visibility 'workspace'.
 */
export async function workspaceIcpContext(sb, ws) {
  const icp = await markedFileText(sb, ws, 'icp');
  if (!icp) return null;
  // What OpenNous learned (GET-1044) is not the ICP's own words: scoring and the mirror read the prose.
  const text = withoutLearnedBlock(icp.text);
  return text.trim() ? { ...icp, text } : null;
}

// The ICP file's learned block (GET-1044): which signals predict a win, from closed deals. OpenNous
// writes it between these markers, the same block the plugin writes into a repo's own ICP file
// (api cloud icpModel.mjs renderIcpBlock); everything outside it is the workspace's own words.
export const ICP_LEARNED_START = '<!-- nous:icp start -->';
export const ICP_LEARNED_END = '<!-- nous:icp end -->';
const LEARNED_RE = /\n*<!-- nous:icp start -->[\s\S]*?<!-- nous:icp end -->\n*/;

/** The text without its learned block. Pure. */
export function withoutLearnedBlock(text) {
  return String(text ?? '').replace(LEARNED_RE, '\n\n').trim();
}

/** The learned block in the text, or null. Pure. */
export function learnedBlockOf(text) {
  return String(text ?? '').match(/<!-- nous:icp start -->[\s\S]*?<!-- nous:icp end -->/)?.[0] ?? null;
}

/** The text with `block` as its learned block: in place of the old one, else at the end. Pure. */
export function withLearnedBlock(text, block) {
  const s = String(text ?? '');
  return LEARNED_RE.test(s) ? s.replace(LEARNED_RE, `\n\n${block}\n`).trim() + '\n' : `${s.trimEnd()}\n\n${block}\n`;
}

/** The workspace's About us file as text (GET-1036), the same shape as workspaceIcpContext, or null. */
export async function workspaceAboutContext(sb, ws) {
  return markedFileText(sb, ws, 'about');
}

async function markedFileText(sb, ws, kind) {
  let file;
  try { file = await one(sb.from('workspace_context_files').select(FILE_COLS).eq('workspace_id', ws).eq('kind', kind).maybeSingle()); }
  catch (e) { if (missingLibrary(e)) return null; throw e; }
  if (!file) return null;
  let text = file.body ?? '';
  if (file.document_id) {
    const doc = await one(sb.from('documents').select('title, body_md, status').eq('workspace_id', ws).eq('id', file.document_id).maybeSingle());
    if (!doc || doc.status === 'deleted') return null;
    text = doc.body_md ?? '';
  }
  if (!String(text).trim()) return null;
  return { id: file.id, title: file.title, text: String(text), updated_at: file.icp_marked_at && file.icp_marked_at > file.updated_at ? file.icp_marked_at : file.updated_at };
}

/**
 * The text the ICP scorecard is built from (GET-875). With a marked ICP file, the file IS the ICP:
 * it goes first as [ICP] and the ICP-category notes are left out (they are older ICP prose that
 * would contradict it); the other GTM notes (Market, Product, ...) still follow as context. Without
 * one, the notes exactly as before. `notes`: [{ category, content }]. Pure.
 */
export function scorecardSeedText(notes, icpFile = null) {
  const list = Array.isArray(notes) ? notes : [];
  if (!icpFile?.text?.trim()) return list.map(m => `[${m.category}] ${m.content}`).join('\n').trim();
  const rest = list.filter(m => String(m.category ?? '').toUpperCase() !== 'ICP' && String(m.metadata?.category_raw ?? '').toUpperCase() !== 'ICP');
  return [`[ICP] ${icpFile.text.trim()}`, ...rest.map(m => `[${m.category}] ${m.content}`)].join('\n').trim();
}
