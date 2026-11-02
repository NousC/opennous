// What operators give people and their agents (GET-1122): a skill or a pinned instruction, for one
// person, a GTM role or everyone. A person's agent reads them through the desk. Every change goes in
// workspace_changes with what it replaced, so it can be rolled back. Nothing is deleted.
import { randomUUID } from 'node:crypto';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
/** One line: a title reaches other people's agents, so it can't carry its own headings. Pure. */
export const oneLine = (s) => String(s ?? '').replace(/[\s\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
async function rows(q) { const { data, error } = await q; if (error) throw error; return data ?? []; }
async function one(q) { const { data, error } = await q; if (error) throw error; return data; }
const now = () => new Date().toISOString();
const COLS = 'id, kind, title, body, target_user_id, target_role, status, updated_at';
const FIELDS = ['kind', 'title', 'body', 'target_user_id', 'target_role', 'status'];
const pick = (a) => Object.fromEntries(FIELDS.map(k => [k, a[k] ?? null]));

/** Who an assignment is for, in words. Pure. */
export const audienceOf = (a, names = {}) => a.target_user_id ? (names[a.target_user_id] ?? 'One person') : a.target_role ? `Role: ${a.target_role}` : 'Everyone';

/** Is this assignment for this person? 'ambassador' holds every role. Pure. */
export function assignedTo(a, { userId, roles = [] }) {
  if (a.status !== 'active') return false;
  if (a.target_user_id) return a.target_user_id === userId;
  if (a.target_role) return roles.includes(a.target_role) || roles.includes('ambassador');
  return true;
}

/** A person's GTM roles in this workspace. */
export async function rolesOf(sb, ws, userId) {
  const m = await one(sb.from('workspace_members').select('job_roles, job_role').eq('workspace_id', ws).eq('user_id', userId).maybeSingle());
  return Array.isArray(m?.job_roles) && m.job_roles.length ? m.job_roles : m?.job_role ? [m.job_role] : [];
}

export async function logChange(sb, ws, actor, entry) {
  return one(sb.from('workspace_changes').insert({ workspace_id: ws, actor_user_id: actor, ...entry }).select('id').single());
}

export async function listAssignments(sb, ws) {
  return rows(sb.from('workspace_assignments').select(COLS).eq('workspace_id', ws).eq('status', 'active').order('updated_at', { ascending: false }).limit(500));
}

export async function assignmentsFor(sb, ws, who) {
  return (await listAssignments(sb, ws)).filter(a => assignedTo(a, who));
}

function validate({ kind, title, body, target_user_id, target_role }) {
  if (!['skill', 'pin'].includes(kind)) fail(400, 'Choose a skill or a pin.');
  if (typeof title !== 'string' || !title.trim() || title.length > 200) fail(400, 'Give it a title of up to 200 characters.');
  if (typeof body !== 'string' || !body.trim() || body.length > 65536) fail(400, 'Write what it says, up to 64 KB.');
  if (target_user_id && target_role) fail(400, 'Choose one person or one role.');
}

/** Add one, or with `id` change one. A field left out of a change stays as it was, so an edit never
 *  widens who it reaches: pass target_user_id and target_role as null to send it to everyone. */
export async function saveAssignment(sb, ws, actor, input) {
  const current = input.id ? await one(sb.from('workspace_assignments').select(COLS).eq('workspace_id', ws).eq('id', input.id).eq('status', 'active').maybeSingle()) : null;
  if (input.id && !current) fail(404, 'Assignment not found.');
  const keep = (k) => (input[k] !== undefined ? input[k] : current?.[k] ?? null);
  const merged = { kind: keep('kind'), title: keep('title'), body: keep('body'), target_user_id: keep('target_user_id'), target_role: keep('target_role') };
  validate(merged);
  const fields = { ...merged, title: oneLine(merged.title) };
  if (fields.target_user_id) {
    const seat = await one(sb.from('workspace_members').select('user_id').eq('workspace_id', ws).eq('user_id', fields.target_user_id).maybeSingle());
    if (!seat) fail(404, 'That person is not in this workspace.');
  }
  // Logged before it applies: a change that reaches people's agents is never unrecorded.
  const id = current?.id ?? randomUUID();
  await logChange(sb, ws, actor, { action: current ? `${fields.kind}_updated` : `${fields.kind}_assigned`, subject: fields.title, audience: audienceOf(fields), assignment_id: id, before: current ? pick(current) : null, after: { ...fields, status: 'active' } });
  return current
    ? one(sb.from('workspace_assignments').update({ ...fields, updated_by: actor, updated_at: now() }).eq('workspace_id', ws).eq('id', id).select(COLS).single())
    : one(sb.from('workspace_assignments').insert({ id, workspace_id: ws, ...fields, status: 'active', created_by: actor, updated_by: actor }).select(COLS).single());
}

export async function removeAssignment(sb, ws, actor, id) {
  const current = await one(sb.from('workspace_assignments').select(COLS).eq('workspace_id', ws).eq('id', id).eq('status', 'active').maybeSingle());
  if (!current) fail(404, 'Assignment not found.');
  await logChange(sb, ws, actor, { action: `${current.kind}_removed`, subject: current.title, audience: audienceOf(current), assignment_id: id, before: pick(current), after: { ...pick(current), status: 'removed' } });
  return one(sb.from('workspace_assignments').update({ status: 'removed', updated_by: actor, updated_at: now() }).eq('workspace_id', ws).eq('id', id).select(COLS).single());
}

export async function listChanges(sb, ws, { limit = 50 } = {}) {
  return rows(sb.from('workspace_changes').select('id, action, subject, audience, assignment_id, actor_user_id, rolled_back_at, created_at').eq('workspace_id', ws).order('created_at', { ascending: false }).limit(Math.min(limit, 200)));
}

/**
 * Put an assignment back as it was before this change. Only the newest change still standing can be
 * undone, so a rollback never overwrites later work or brings back what was removed since. The
 * rollback is a change too, and claiming it first means two at once can't both run.
 */
export async function rollbackChange(sb, ws, actor, changeId) {
  const c = await one(sb.from('workspace_changes').select('id, action, assignment_id, before, subject, audience, rolled_back_at, created_at').eq('workspace_id', ws).eq('id', changeId).maybeSingle());
  if (!c) fail(404, 'Change not found.');
  if (!c.assignment_id) fail(400, 'This change has no rollback. Push the earlier version instead.');
  if (c.action === 'rolled_back') fail(400, 'A rollback can\'t be rolled back. Assign it again instead.');
  if (c.rolled_back_at) fail(409, 'This change was already rolled back.');
  const standing = await rows(sb.from('workspace_changes').select('id, action, rolled_back_at').eq('workspace_id', ws).eq('assignment_id', c.assignment_id).order('created_at', { ascending: false }));
  if (standing.find(x => x.action !== 'rolled_back' && !x.rolled_back_at)?.id !== c.id) fail(409, 'A later change came after this one. Undo that first.');
  const restored = c.before ?? { status: 'removed' };
  const claimed = await rows(sb.from('workspace_changes').update({ rolled_back_at: now() }).eq('workspace_id', ws).eq('id', c.id).is('rolled_back_at', null).select('id'));
  if (!claimed.length) fail(409, 'This change was already rolled back.');
  const saved = await one(sb.from('workspace_assignments').update({ ...restored, updated_by: actor, updated_at: now() }).eq('workspace_id', ws).eq('id', c.assignment_id).select(COLS).single());
  await logChange(sb, ws, actor, { action: 'rolled_back', subject: c.subject, audience: c.audience, assignment_id: c.assignment_id, after: pick(saved) });
  return saved;
}

/** What a person's agent should know now. New means changed since the agent last looked. */
export async function deskFor(sb, ws, { userId, roles, documents }) {
  const seen = (await one(sb.from('workspace_desk_seen').select('seen_at').eq('workspace_id', ws).eq('user_id', userId).maybeSingle()))?.seen_at ?? null;
  const fresh = (at) => !seen || Date.parse(at) > Date.parse(seen);
  const assigned = (await assignmentsFor(sb, ws, { userId, roles })).map(a => ({ id: a.id, kind: a.kind, title: oneLine(a.title), new: fresh(a.updated_at), ...(a.kind === 'pin' ? { body: a.body } : {}) }));
  const docs = documents.filter(d => fresh(d.updated_at)).map(d => ({ id: d.id, title: oneLine(d.title), folder: oneLine(d.folder ?? 'Library'), updated_at: d.updated_at }));
  await one(sb.from('workspace_desk_seen').upsert({ workspace_id: ws, user_id: userId, seen_at: now() }, { onConflict: 'workspace_id,user_id' }).select('user_id').single());
  return { seen_at: seen, pins: assigned.filter(a => a.kind === 'pin'), skills: assigned.filter(a => a.kind === 'skill'), new_documents: docs };
}
