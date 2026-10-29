// Settings > Knowledge, the workspace context library (GET-875), mounted at /api/context. Open source
// since 2026-10-29: these routes were the RevBoxes router's (Cloud, /api/revboxes/context-*).
//
//   GET    /library                             every file the viewer may see, newest first
//   POST   /files                               add one: { title, body | document_id, kind?, visibility?, revbox_ids? }
//   PATCH  /files/:fileId                       edit it; kind 'icp' or 'about' marks it
//   DELETE /files/:fileId                       delete it (its versions stay)
//   GET    /files/:fileId/versions              its versions (GET-1038), newest first
//   POST   /files/:fileId/versions/:id/restore  put one back, as a new version
//   GET    /repo                                the company repo (GET-1037), and whether the viewer may manage it
//   POST   /repo                                connect it: { repo, token, branch?, base_path? } (owner/admin)
//   POST   /repo/sync                           read it now
//   DELETE /repo                                disconnect it (owner/admin); the files stay in both places
//   GET    /living-files                        the Intelligence files (GET-1039), on or off
//   POST   /living-files/:key                   turn one on or off: { enabled } (owner/admin)
//   POST   /files/:fileId/icp-rebuild           rebuild ICP scoring from the ICP file (owner/admin)
//
// The About us file (GET-1036) is mirrored into the positioning foundation on every save, and with a
// company repo connected (GET-1037, lib/contextRepo.mjs) each save is committed there. Marking a file
// ICP builds ICP scoring from it and the ICP file's text is mirrored into the workspace ICP (GET-878,
// lib/icpContextFile.mjs). All of it is open source since 2026-10-29. Where the learned scorer is not
// turned on (an open-source build), the ICP file is kept and mirrored, and the answer says scoring
// does not read it. RevBox tags are the library's own seam (registerContextBoxes in @nous/core).
import { Router } from 'express';
import {
  getSupabaseClient, getDocument, listContextLibrary, loadContextFile, createContextFile, updateContextFile,
  deleteContextFile, validateContextFile, listContextVersions, restoreContextVersion,
} from '@nous/core';
import { viewerVisibleAccountSet } from '../../lib/visibility.mjs';
import { mirrorAboutFile } from '../../lib/aboutContextFile.mjs';
import { loadContextRepo, repoOut, connectContextRepo, disconnectContextRepo, pullContextRepo, pushContextFile } from '../../lib/contextRepo.mjs';
import { markIcpFile, mirrorIcpFile } from '../../lib/icpContextFile.mjs';
import { listLivingFiles, setLivingFile } from '../../lib/livingFiles.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

// ── ICP scoring from the ICP file (GET-878) ──────────────────────────────────
//   markIcp(sb, ws, { confirm, admin, rebuild? }, write?) -> { result, icp }   mark (or rebuild) and score
//   mirrorIcp(sb, ws) -> { status }                                          the ICP file's text, mirrored
const markIcp = (sb, ws, opts, write) => markIcpFile(sb, ws, opts, write);
const mirrorIcp = (sb, ws) => mirrorIcpFile(sb, ws);

// ── The company repo (GET-1037) ──────────────────────────────────────────────
// Each save is committed in the background: GitHub's latency never holds the save, and a failure is
// recorded on the connection, shown on the Knowledge page, and retried by the next save or the poll.
const commit = (sb, req, fileId, changelog) => {
  pushContextFile(sb, req.workspaceId, fileId, { who: { kind: 'person', userId: req.internalUserId }, changelog })
    .catch(e => console.warn('[context-repo] commit failed:', e?.message ?? e));
};
/** What the repo changed, applied where it is read: the ICP and About us mirrors. */
export async function afterRepoChange(sb, ws, file) {
  if (file.kind === 'icp') await mirrorIcp(sb, ws);
  if (file.kind === 'about') await mirrorAboutFile(sb, ws);
}

/** The route wrapper: a signed-in member, valid ids, and the library's errors as JSON. */
export function knowledgeRoute(fn) {
  return async (req, res) => {
    try {
      if (!req.workspaceId || !req.internalUserId) return res.status(400).json({ error: 'Workspace and signed-in member are required.' });
      if (Object.values(req.params).some(id => !uuid.test(id))) return res.status(400).json({ error: 'Invalid identifier.' });
      const sb = getSupabaseClient();
      // A member of the workspace first, before any document is read on their behalf.
      const { data: member, error } = await sb.from('workspace_members').select('user_id').eq('workspace_id', req.workspaceId).eq('user_id', req.internalUserId).maybeSingle();
      if (error) throw error;
      if (!member) invalid('You are not a member of this workspace.', 403);
      await fn(req, res, sb);
    } catch (e) {
      if (e.code === '42P01' || e.code === 'PGRST205' || /workspace_context_files.*schema cache/i.test(e.message ?? '')) return res.status(409).json({ error: 'The Knowledge database migration has not been applied.' });
      if (!e.status) console.error('[knowledge]', e);
      res.status(e.status ?? 500).json({ error: e.status ? e.message : 'Could not save or load the file.', ...(e.status && e.reply ? e.reply : {}) });
    }
  };
}

/** A document the viewer may read, or a 404: a linked file is shown only while that holds. */
export async function accessibleContextDocument(sb, req, id) {
  if (!uuid.test(id)) invalid('Invalid document identifier.');
  const set = await viewerVisibleAccountSet(sb, req.workspaceId, req.internalUserId, { isAdmin: req.viewerScope === 'admin' });
  const doc = (await getDocument(sb, req.workspaceId, id))?.document ?? null;
  if (!doc || (doc.subject_entity_id && !set.unrestricted && !set.ids.has(doc.subject_entity_id))) invalid('Document not found.', 404);
  return doc;
}
/**
 * A library file that is a linked document is changed only by someone who can still read that
 * document (GET-875): to them it is "not found", as in the list. `open(id)` throws a 404 for a
 * document the viewer cannot read; any other error propagates.
 */
export async function contextFileDocumentGate(file, open) {
  if (!file?.document_id) return;
  try { await open(file.document_id); } catch (e) { if (e.status === 404) invalid('Context file not found.', 404); throw e; }
}
/** A saved library file as the response returns it: a linked document's title and text only while the
 * viewer can read it, otherwise a neutral stand-in (never the raw row's document title). */
export async function readableContextFile(file, open) {
  if (!file?.document_id) return file;
  try { const doc = await open(file.document_id); return { ...file, title: doc.title ?? file.title, body: doc.body_md ?? '' }; }
  catch (e) { if (e.status !== 404) throw e; return { ...file, title: 'Linked document', body: '' }; }
}
/** Does this PATCH mark the file ICP (it was not)? Unmarking or editing never switches the scorer. */
export const icpMarking = (body, before) => body?.kind === 'icp' && before?.kind !== 'icp';

async function withDocumentBodies(sb, req, files) {
  const out = [];
  for (const f of files) {
    if (!f.document_id) { out.push(f); continue; }
    try { const doc = await accessibleContextDocument(sb, req, f.document_id); out.push({ ...f, title: doc.title ?? f.title, body: doc.body_md ?? '' }); } catch (e) { if (e.status !== 404) throw e; }
  }
  return out;
}
const opener = (sb, req) => id => accessibleContextDocument(sb, req, id);
const admin = (role) => ['owner', 'admin'].includes(role);

export const contextRouter = Router();

contextRouter.get('/library', knowledgeRoute(async (req, res, sb) => {
  const library = await listContextLibrary(sb, req.workspaceId, req.internalUserId);
  const icp = library.files.find(f => f.kind === 'icp') ?? null;
  const about = library.files.find(f => f.kind === 'about') ?? null;
  res.json({ ...library, files: await withDocumentBodies(sb, req, library.files), icp_file_id: icp?.id ?? null, about_file_id: about?.id ?? null });
}));
contextRouter.post('/files', knowledgeRoute(async (req, res, sb) => {
  const { confirm_scorer_switch: confirm, ...input } = req.body ?? {};
  let body = input;
  if (Array.isArray(body.revbox_ids) && body.revbox_ids.some(id => typeof id !== 'string' || !uuid.test(id))) invalid('Choose valid RevBoxes.');
  if (body.document_id) { const doc = await accessibleContextDocument(sb, req, body.document_id); body = { ...body, document_id: doc.id, title: body.title || doc.title, body: '' }; }
  const create = () => createContextFile(sb, req.workspaceId, req.internalUserId, body);
  if (body.kind !== 'icp') {
    const file = await create();
    // The About us file (GET-1036): what we sell, mirrored where the readers look for it.
    if (file.kind === 'about') await mirrorAboutFile(sb, req.workspaceId);
    commit(sb, req, file.id, input.changelog || 'Created');
    return res.status(201).json({ file: await readableContextFile(file, opener(sb, req)) });
  }
  // Marked ICP on creation (GET-878): on an 'external' workspace this is confirmed first (409, nothing
  // written), then Nous scores from the file. Otherwise the first scorecard if there is none.
  const error = validateContextFile(body); if (error) invalid(error);
  const { result: file, icp } = await markIcp(sb, req.workspaceId, { confirm: confirm === true, admin: !req.workspaceRole || admin(req.workspaceRole) }, create);
  commit(sb, req, file.id, input.changelog || 'Created');
  res.status(201).json({ file: await readableContextFile(file, opener(sb, req)), ...(icp ? { icp } : {}) });
}));
contextRouter.patch('/files/:fileId', knowledgeRoute(async (req, res, sb) => {
  const { confirm_scorer_switch: confirm, ...body } = req.body ?? {};
  if (Array.isArray(body.revbox_ids) && body.revbox_ids.some(id => typeof id !== 'string' || !uuid.test(id))) invalid('Choose valid RevBoxes.');
  const before = await loadContextFile(sb, req.workspaceId, req.internalUserId, req.params.fileId);
  await contextFileDocumentGate(before.file, opener(sb, req));
  const update = () => updateContextFile(sb, req.workspaceId, req.internalUserId, req.params.fileId, body);
  if (icpMarking(body, before.file)) {
    // Marked now (GET-878): confirmed first on an 'external' workspace, then Nous scores from it.
    const error = validateContextFile(body, { partial: true }); if (error) invalid(error);
    const { result: file, icp } = await markIcp(sb, req.workspaceId, { confirm: confirm === true, admin: admin(before.role) }, update);
    commit(sb, req, file.id, body.changelog || 'Marked as ICP');
    return res.json({ file: await readableContextFile(file, opener(sb, req)), ...(icp ? { icp } : {}) });
  }
  const file = await update();
  if (file.kind === 'about') await mirrorAboutFile(sb, req.workspaceId);
  if (['title', 'body', 'kind', 'visibility'].some(k => k in body)) commit(sb, req, file.id, body.changelog || null);
  // The ICP file's text changed: the workspace ICP follows it, never a re-score. Unmarking leaves
  // the last text and the scorer setting as they are.
  const foundation = file.kind === 'icp' ? (await mirrorIcp(sb, req.workspaceId)).status : null;
  res.json({ file: await readableContextFile(file, opener(sb, req)), ...(foundation ? { icp: { status: 'saved', foundation } } : {}) });
}));
contextRouter.delete('/files/:fileId', knowledgeRoute(async (req, res, sb) => {
  await contextFileDocumentGate((await loadContextFile(sb, req.workspaceId, req.internalUserId, req.params.fileId)).file, opener(sb, req));
  await deleteContextFile(sb, req.workspaceId, req.internalUserId, req.params.fileId);
  res.json({ ok: true });
}));
// A file's versions (GET-1038): newest first, each with its author and change note.
contextRouter.get('/files/:fileId/versions', knowledgeRoute(async (req, res, sb) => {
  res.json({ versions: await listContextVersions(sb, req.workspaceId, req.internalUserId, req.params.fileId) });
}));
// Put a version back. The restore is a new version; the ICP and About us files' mirrors follow.
contextRouter.post('/files/:fileId/versions/:versionId/restore', knowledgeRoute(async (req, res, sb) => {
  const file = await restoreContextVersion(sb, req.workspaceId, req.internalUserId, req.params.fileId, req.params.versionId);
  if (file.kind === 'icp') await mirrorIcp(sb, req.workspaceId);
  if (file.kind === 'about') await mirrorAboutFile(sb, req.workspaceId);
  commit(sb, req, file.id, 'Restored a version');
  res.json({ file: await readableContextFile(file, opener(sb, req)) });
}));

const repoAdmin = (req) => ['owner', 'admin'].includes(req.workspaceRole);
contextRouter.get('/repo', knowledgeRoute(async (req, res, sb) => {
  res.json({ repo: repoOut(await loadContextRepo(sb, req.workspaceId)), can_manage: repoAdmin(req) });
}));
contextRouter.post('/repo', knowledgeRoute(async (req, res, sb) => {
  if (!repoAdmin(req)) invalid('Only a workspace owner or admin can connect the repo.', 403);
  const { repo, token, branch, base_path } = req.body ?? {};
  res.json(await connectContextRepo(sb, req.workspaceId, req.internalUserId, { repo, token, branch, base_path }, { afterChange: f => afterRepoChange(sb, req.workspaceId, f) }));
}));
contextRouter.post('/repo/sync', knowledgeRoute(async (req, res, sb) => {
  const cfg = await loadContextRepo(sb, req.workspaceId);
  if (!cfg) invalid('No repo connected.', 404);
  const pulled = await pullContextRepo(sb, cfg, { via: 'manual', afterChange: f => afterRepoChange(sb, req.workspaceId, f) });
  res.json({ pulled, repo: repoOut(await loadContextRepo(sb, req.workspaceId)) });
}));
contextRouter.delete('/repo', knowledgeRoute(async (req, res, sb) => {
  if (!repoAdmin(req)) invalid('Only a workspace owner or admin can disconnect the repo.', 403);
  await disconnectContextRepo(sb, req.workspaceId);
  res.json({ ok: true });
}));

// Intelligence (GET-1039, GET-1044): files OpenNous writes and keeps current. Owners/admins turn them on.
contextRouter.get('/living-files', knowledgeRoute(async (req, res, sb) => {
  res.json({ files: await listLivingFiles(sb, req.workspaceId), can_manage: repoAdmin(req) });
}));
contextRouter.post('/living-files/:key', (req, res, next) => {
  // The key is a name, not an id, so it skips knowledgeRoute's id check.
  if (!/^[a-z_]{2,40}$/.test(req.params.key)) return res.status(400).json({ error: 'Unknown intelligence file.' });
  const key = req.params.key; req.params = {};
  return knowledgeRoute(async (rq, rs, sb) => {
    if (!repoAdmin(rq)) invalid('Only a workspace owner or admin can turn intelligence on or off.', 403);
    rs.json({ file: await setLivingFile(sb, rq.workspaceId, rq.internalUserId, key, rq.body?.enabled !== false) });
  })(req, res, next);
});
// "Rebuild scoring from this ICP": the explicit trigger that rebuilds the scorecard from the file.
contextRouter.post('/files/:fileId/icp-rebuild', knowledgeRoute(async (req, res, sb) => {
  const { file, role } = await loadContextFile(sb, req.workspaceId, req.internalUserId, req.params.fileId);
  await contextFileDocumentGate(file, opener(sb, req));
  if (!admin(role)) invalid('Only a workspace owner or admin can rebuild ICP scoring.', 403);
  if (file.kind !== 'icp') invalid('Mark this file as the ICP first.');
  // On an 'external' workspace this never answers external_scorer: confirm, switch, rebuild (GET-878).
  const { icp } = await markIcpFile(sb, req.workspaceId, { rebuild: true, confirm: req.body?.confirm_scorer_switch === true });
  res.json({ icp });
}));
