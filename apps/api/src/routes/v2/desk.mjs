// The Company OS's working surface (GET-1122). /v2/desk is what one person's agent reads; /v2/assignments
// and /v2/changes are for operators. All of them need a person: a key with no one behind it has no
// desk and assigns nothing. Mounted behind verifyAuthEither, so the app and agents share them.
import { Router } from 'express';
import {
  getSupabaseClient, NO_CONTENT_VIEWER, rolesOf, assignmentsFor, listAssignments, saveAssignment, removeAssignment,
  listChanges, rollbackChange, deskFor, readableContextFiles, audienceOf,
} from '@nous/core';

const personOf = (req) => (req.memberUserId && !req.noContent && req.memberUserId !== NO_CONTENT_VIEWER ? req.memberUserId : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wrap = (fn) => async (req, res) => {
  if (req.params.id && !UUID.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  try { return await fn(req, res, getSupabaseClient()); }
  catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    console.error(`[${req.method} ${req.originalUrl}]`, err);
    return res.status(500).json({ error: 'internal_error' });
  }
};
const operator = (req, res, next) => {
  if (!personOf(req) || req.viewerScope !== 'admin') return res.status(403).json({ error: 'operators_only', detail: 'Only a workspace owner or admin can do this, with their own key.' });
  return next();
};
const person = (req, res, next) => (personOf(req) ? next() : res.status(403).json({ error: 'person_required', detail: 'A desk belongs to a person. Sign in as yourself.' }));
const out = (a) => ({ ...a, audience: audienceOf(a) });

export const deskV2Router = Router();
// GET /v2/desk -> pins, skills (titles), new documents. Reading it marks them seen.
deskV2Router.get('/', person, wrap(async (req, res, sb) => {
  const userId = personOf(req);
  const documents = (await readableContextFiles(sb, req.workspaceId, { userId, admin: req.viewerScope === 'admin' })).filter(d => d.folder);
  return res.json(await deskFor(sb, req.workspaceId, { userId, roles: await rolesOf(sb, req.workspaceId, userId), documents }));
}));
// GET /v2/desk/skills/:id -> one skill assigned to this person, with its text.
deskV2Router.get('/skills/:id', person, wrap(async (req, res, sb) => {
  const userId = personOf(req);
  const mine = await assignmentsFor(sb, req.workspaceId, { userId, roles: await rolesOf(sb, req.workspaceId, userId) });
  const skill = mine.find(a => a.id === req.params.id);
  return skill ? res.json(skill) : res.status(404).json({ error: 'not_found' });
}));

export const assignmentsV2Router = Router();
assignmentsV2Router.use(operator);
// GET /v2/assignments?user= -> everything, or what one person gets.
assignmentsV2Router.get('/', wrap(async (req, res, sb) => {
  const user = req.query.user ? String(req.query.user) : null;
  const list = user ? await assignmentsFor(sb, req.workspaceId, { userId: user, roles: await rolesOf(sb, req.workspaceId, user) }) : await listAssignments(sb, req.workspaceId);
  return res.json({ assignments: list.map(out) });
}));
// POST /v2/assignments { id?, kind, title, body, target_user_id?, target_role? }
assignmentsV2Router.post('/', wrap(async (req, res, sb) => {
  const { id, kind, title, body, target_user_id, target_role } = req.body ?? {};
  return res.status(id ? 200 : 201).json(out(await saveAssignment(sb, req.workspaceId, personOf(req), { id, kind, title, body, target_user_id, target_role })));
}));
assignmentsV2Router.post('/:id/remove', wrap(async (req, res, sb) => res.json(out(await removeAssignment(sb, req.workspaceId, personOf(req), req.params.id)))));

export const changesV2Router = Router();
changesV2Router.use(operator);
changesV2Router.get('/', wrap(async (req, res, sb) => res.json({ changes: await listChanges(sb, req.workspaceId) })));
changesV2Router.post('/:id/rollback', wrap(async (req, res, sb) => res.json(out(await rollbackChange(sb, req.workspaceId, personOf(req), req.params.id)))));
