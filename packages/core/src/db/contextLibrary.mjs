// Workspace context library (GET-875). Context is saved once for the workspace
// (workspace_context_files) and TAGGED to RevBoxes (revbox_context_links), so one file serves several
// boxes. supabase/migrations/2026_10_15_context_library.sql copied every legacy revbox_context row into
// a file with the same id plus one link; until that table is retired, a box's context is its linked
// files plus any legacy row the copy has not adopted yet (written by an older API after the migration).
//
// Who sees a file (the same rule as a box's references before):
//   - visibility 'workspace': every workspace member;
//   - visibility 'boxes' (the default and every backfilled file): its creator, and the people who can
//     open a box it is tagged to (revboxAccess: owner, member, or anyone for a shared box).
// A box's RUN reads only the files linked to that box, whatever their visibility. A file that is a
// linked document is also subject to the document's own visibility, which the API checks on read.
// The ICP file (kind 'icp', at most one per workspace, always 'workspace') is what ICP scoring reads:
// see workspaceIcpContext and docs/revboxes/CONTEXT_LIBRARY.md.
import { listRevboxes, loadRevbox } from './revboxes.mjs';

export const CONTEXT_KINDS = ['reference', 'instructions', 'icp'];
export const CONTEXT_VISIBILITY = ['boxes', 'workspace'];
const MAX_BODY = 262144;
const FILE_COLS = 'id, workspace_id, title, kind, body, document_id, visibility, visibility_before_icp, created_by, updated_by, icp_marked_at, created_at, updated_at';

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
  if (file.kind === 'icp') return admin;
  if (file.created_by === uid || admin) return true;
  return links.length > 0 && links.every(id => ['owner', 'editor'].includes(boxAccess.get(id)));
}

/** A library request body, validated. -> error message or null. Pure. */
export function validateContextFile(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid context file.';
  const keys = ['title', 'body', 'kind', 'visibility', 'document_id', 'revbox_ids'];
  if (Object.keys(body).some(k => !keys.includes(k))) return 'Unsupported context file field.';
  if ((!partial || 'title' in body) && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200)) return 'Give the file a title of up to 200 characters.';
  if ('body' in body && (typeof body.body !== 'string' || Buffer.byteLength(body.body) > MAX_BODY)) return 'Write or upload text up to 256 KB.';
  if ('kind' in body && !CONTEXT_KINDS.includes(body.kind)) return 'Choose reference, instructions or ICP.';
  if ('visibility' in body && !CONTEXT_VISIBILITY.includes(body.visibility)) return 'Choose who can see this file.';
  if ('document_id' in body && body.document_id != null && typeof body.document_id !== 'string') return 'Choose a valid document.';
  if ('revbox_ids' in body && (!Array.isArray(body.revbox_ids) || body.revbox_ids.length > 100 || body.revbox_ids.some(id => typeof id !== 'string'))) return 'Choose valid RevBoxes.';
  return null;
}

/** The viewer's boxes and access: Map(id -> 'owner'|'editor'|'viewer') plus the rows. */
async function viewerBoxes(sb, ws, uid) {
  const boxes = await listRevboxes(sb, ws, uid);
  return { boxes, access: new Map(boxes.map(b => [b.id, b.access])) };
}
async function linksOf(sb, ws, fileIds = null) {
  let q = sb.from('revbox_context_links').select('revbox_id, context_file_id, created_at').eq('workspace_id', ws);
  if (fileIds) { if (!fileIds.length) return []; q = q.in('context_file_id', fileIds); }
  return rows(q);
}
const linkMap = (links) => { const m = new Map(); for (const l of links) { if (!m.has(l.context_file_id)) m.set(l.context_file_id, []); m.get(l.context_file_id).push(l.revbox_id); } return m; };

/** A file row as the API returns it, with the viewer's tags (hidden boxes only counted). */
function fileOut(f, boxIds, access, boxes, uid, role) {
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
    .map(f => fileOut(f, byFile.get(f.id) ?? [], access, boxes, uid, role));
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

/** Make `fileId` the workspace's ICP file (on) or a plain reference again (off). Owners/admins only. */
async function setIcp(sb, ws, uid, role, file, on) {
  if (!isAdmin(role)) fail(403, 'Only a workspace owner or admin can choose the ICP file.');
  if (on && file.kind === 'icp') return file;
  if (!on && file.kind !== 'icp') return file;
  // Marking shares the file with the workspace; unmarking puts back the visibility it had before.
  const patch = on ? { kind: 'icp', visibility: 'workspace', visibility_before_icp: file.visibility, icp_marked_at: now(), updated_by: uid, updated_at: now() }
    : { kind: 'reference', visibility: file.visibility_before_icp ?? file.visibility, visibility_before_icp: null, icp_marked_at: null, updated_by: uid, updated_at: now() };
  try {
    return await one(sb.from('workspace_context_files').update(patch).eq('workspace_id', ws).eq('id', file.id).select(FILE_COLS).single());
  } catch (e) {
    if (uniqueViolation(e)) fail(409, 'This workspace already has an ICP file. Unmark it first.');
    throw e;
  }
}

/** Tag/untag: add or remove links so the file is on exactly `wanted` among the boxes the viewer can open. */
async function retag(sb, ws, uid, fileId, current, access, wanted) {
  const want = new Set(wanted);
  for (const id of want) if (!access.has(id)) fail(404, 'RevBox not found.');
  const add = [...want].filter(id => !current.includes(id));
  const drop = current.filter(id => access.has(id) && !want.has(id));   // a box the viewer cannot see keeps its tag
  for (const id of [...add, ...drop]) if (!['owner', 'editor'].includes(access.get(id))) fail(403, 'Only an owner or editor of a RevBox can change its context.');
  for (const id of add) await rows(sb.from('revbox_context_links').upsert({ revbox_id: id, context_file_id: fileId, workspace_id: ws, created_by: uid }, { onConflict: 'revbox_id,context_file_id', ignoreDuplicates: true }));
  for (const id of drop) await unlinkContext(sb, ws, id, fileId);
  for (const id of [...add, ...drop]) await rows(sb.from('revboxes').update({ updated_at: now() }).eq('workspace_id', ws).eq('id', id));
  return [...current.filter(id => !drop.includes(id)), ...add];
}

/** Remove a file from one box: the link and the legacy revbox_context row with the same id. */
export async function unlinkContext(sb, ws, boxId, fileId) {
  try { await rows(sb.from('revbox_context_links').delete().eq('workspace_id', ws).eq('revbox_id', boxId).eq('context_file_id', fileId)); }
  catch (e) { if (!missingLibrary(e)) throw e; }
  await rows(sb.from('revbox_context').delete().eq('workspace_id', ws).eq('revbox_id', boxId).eq('id', fileId));
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
  if (kind === 'icp' && !isAdmin(role)) fail(403, 'Only a workspace owner or admin can choose the ICP file.');
  const visibility = body.visibility ?? 'boxes';
  // An ICP file is inserted as the ICP: the one-per-workspace index refuses a second one before
  // anything is written (no orphan row, no tags).
  const row = {
    workspace_id: ws, created_by: uid, updated_by: uid, title: clean(body.title, 200), kind,
    body: body.document_id ? '' : (body.body ?? ''), document_id: body.document_id ?? null,
    ...(kind === 'icp' ? { visibility: 'workspace', visibility_before_icp: visibility, icp_marked_at: now() } : { visibility }),
  };
  let file;
  try { file = await one(sb.from('workspace_context_files').insert(row).select(FILE_COLS).single()); }
  catch (e) { if (uniqueViolation(e)) fail(409, 'This workspace already has an ICP file. Unmark it first.'); throw e; }
  const links = await retag(sb, ws, uid, file.id, [], access, wanted);
  return fileOut(file, links, access, boxes, uid, role);
}

/** Edit a file: { title?, body?, kind?, visibility?, revbox_ids? }. kind 'icp' marks it the ICP file. */
export async function updateContextFile(sb, ws, uid, fileId, body) {
  const error = validateContextFile(body, { partial: true }); if (error) fail(400, error);
  let { file, links, role, access, boxes } = await loadContextFile(sb, ws, uid, fileId);
  const content = ['title', 'body', 'visibility'].some(k => k in body) || ('kind' in body && body.kind !== 'icp' && file.kind !== 'icp');
  if (content && !contextFileEditable(file, uid, role, access, links)) fail(403, 'You cannot change this file.');
  if ('document_id' in body && body.document_id !== file.document_id) fail(400, 'A linked document cannot be swapped. Add it as a new file.');
  if (file.document_id && 'body' in body) fail(400, 'This file is a linked document. Edit the document itself.');
  if (file.kind === 'icp' && body.visibility === 'boxes') fail(400, 'The ICP file is shared with the workspace. Unmark it first.');
  if ('kind' in body && (body.kind === 'icp') !== (file.kind === 'icp')) file = await setIcp(sb, ws, uid, role, file, body.kind === 'icp');
  const patch = {};
  if ('title' in body) patch.title = clean(body.title, 200);
  if ('body' in body) patch.body = body.body;
  if ('visibility' in body) patch.visibility = body.visibility;
  if ('kind' in body && body.kind !== 'icp') patch.kind = body.kind;
  if (Object.keys(patch).length) file = await one(sb.from('workspace_context_files').update({ ...patch, updated_by: uid, updated_at: now() }).eq('workspace_id', ws).eq('id', file.id).select(FILE_COLS).single());
  if ('revbox_ids' in body) links = await retag(sb, ws, uid, file.id, links, access, [...new Set(body.revbox_ids)]);
  return fileOut(file, links, access, boxes, uid, role);
}

/** Delete a file everywhere (every tag, and the legacy copies). Its creator or a workspace owner/admin. */
export async function deleteContextFile(sb, ws, uid, fileId) {
  const { file, role } = await loadContextFile(sb, ws, uid, fileId);
  if (file.kind === 'icp' ? !isAdmin(role) : (file.created_by !== uid && !isAdmin(role))) fail(403, file.kind === 'icp' ? 'Only a workspace owner or admin can delete the ICP file.' : 'Only the person who added this file or a workspace admin can delete it.');
  await rows(sb.from('workspace_context_files').delete().eq('workspace_id', ws).eq('id', file.id));
  await rows(sb.from('revbox_context').delete().eq('workspace_id', ws).eq('id', file.id));
}

/** Tag an existing library file to a box (the box's "Add from library"). Box edit rights; file visible. */
export async function linkContextFile(sb, ws, uid, boxId, fileId) {
  await loadRevbox(sb, ws, uid, boxId, true);
  const { file, links, role, access, boxes } = await loadContextFile(sb, ws, uid, fileId);
  const next = await retag(sb, ws, uid, file.id, links, access, [...new Set([...links.filter(id => access.has(id)), boxId])]);
  return fileOut(file, next, access, boxes, uid, role);
}

/**
 * A box's context, in the shape revbox_context rows had ({ id, title, body, document_id, created_by,
 * created_at }) plus kind and visibility: the files linked to the box, then any legacy row not yet
 * adopted (same id = same file). Before the migration, the legacy rows. No access check: callers
 * have loaded the box. Ordered by when each was added to the box.
 */
export async function revboxContextRows(sb, ws, boxId) {
  const legacy = await rows(sb.from('revbox_context').select('id, title, body, document_id, created_by, created_at').eq('workspace_id', ws).eq('revbox_id', boxId).order('created_at'));
  let links;
  try { links = await rows(sb.from('revbox_context_links').select('context_file_id, created_at').eq('workspace_id', ws).eq('revbox_id', boxId).order('created_at')); }
  catch (e) { if (missingLibrary(e)) return legacy.map(r => ({ ...r, kind: 'reference', visibility: 'boxes' })); throw e; }
  const ids = links.map(l => l.context_file_id);
  const files = ids.length ? await rows(sb.from('workspace_context_files').select(FILE_COLS).eq('workspace_id', ws).in('id', ids)) : [];
  const byId = new Map(files.map(f => [f.id, f]));
  const out = [];
  for (const l of links) {
    const f = byId.get(l.context_file_id);
    if (f) out.push({ id: f.id, title: f.title, body: f.body ?? '', document_id: f.document_id ?? null, kind: f.kind, visibility: f.visibility, created_by: f.created_by, created_at: l.created_at ?? f.created_at });
  }
  const seen = new Set(out.map(r => r.id));
  for (const r of legacy) if (!seen.has(r.id)) out.push({ ...r, body: r.body ?? '', kind: 'reference', visibility: 'boxes' });
  return out.map((r, i) => [r, i]).sort((a, b) => String(a[0].created_at ?? '').localeCompare(String(b[0].created_at ?? '')) || a[1] - b[1]).map(([r]) => r);
}

/**
 * Add context to a box from the box page: a new library file tagged to it ({ title, body } or
 * { document_id }), or an existing one ({ file_id }). Before the migration, a legacy row.
 */
export async function addBoxContext(sb, ws, uid, boxId, body) {
  await loadRevbox(sb, ws, uid, boxId, true);
  if (body?.file_id) return linkContextFile(sb, ws, uid, boxId, body.file_id);
  if (typeof body?.title !== 'string' || !body.title.trim() || body.title.length > 200 || typeof body.body !== 'string' || Buffer.byteLength(body.body) > MAX_BODY) fail(400, 'Upload a text reference up to 256 KB.');
  try {
    return await createContextFile(sb, ws, uid, { title: body.title, body: body.document_id ? '' : body.body, ...(body.document_id ? { document_id: body.document_id } : {}), revbox_ids: [boxId] });
  } catch (e) {
    if (!missingLibrary(e)) throw e;
    return one(sb.from('revbox_context').insert({ workspace_id: ws, revbox_id: boxId, created_by: uid, title: clean(body.title, 200), body: body.document_id ? '' : body.body, document_id: body.document_id ?? null }).select('*').single());
  }
}

/**
 * The workspace's ICP file as text for ICP scoring: { id, title, text, updated_at } or null (none
 * marked, the library not migrated, or a linked document that was deleted). A linked document's text
 * is its current body. Workspace-level by design: the ICP file is always visibility 'workspace'.
 */
export async function workspaceIcpContext(sb, ws) {
  let file;
  try { file = await one(sb.from('workspace_context_files').select(FILE_COLS).eq('workspace_id', ws).eq('kind', 'icp').maybeSingle()); }
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
