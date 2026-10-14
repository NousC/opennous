// Who may see and act on a RevBox job (GET-868). A box job is an agent_routines row with revbox_id;
// it, its runs and its output are the box's. A caller sees one only with access to the box (a member
// of a private box, any role, or the box is shared with the team), and acts on one (approve, reject,
// send, run now) only as its owner or an editor. Editing or deleting the job itself happens in
// RevBoxes. Shared by /api/automations, /v2/workflows, /v2/approvals and Cloud's /api/routines.
import { getSupabaseClient, revboxAccess } from '@nous/core';

/** Is this row a RevBox job? Pure. */
export const isBoxJob = (row) => !!row?.revbox_id;
/** The error a query gets before the RevBox migration: no revbox_id column, so no box jobs. */
export const missingBoxColumn = (e) => ['42703', 'PGRST204'].includes(e?.code) && /revbox_id/.test(e?.message ?? '');
/** The line Usage shows for the box jobs a caller may not see: their credits, no names, no counts. */
export const PRIVATE_BOX_JOBS = 'Private RevBox jobs';

/**
 * What the caller may do with each box job on this workspace: Map routineId → 'owner' | 'editor' |
 * 'viewer' | null (null: not theirs to see). A routine not in the map is an ordinary automation.
 * Three queries however many rows the caller lists; `routineIds` narrows it to some routines.
 */
export async function boxJobAccess(supabase, workspaceId, userId, { routineIds = null } = {}) {
  let q = supabase.from('agent_routines').select('id, revbox_id').eq('workspace_id', workspaceId).not('revbox_id', 'is', null);
  if (routineIds) q = q.in('id', routineIds);
  const { data: jobs, error } = await q;
  if (error) { if (missingBoxColumn(error)) return new Map(); throw error; }
  if (!jobs?.length) return new Map();
  const boxIds = [...new Set(jobs.map(j => j.revbox_id))];
  const [boxes, mine] = await Promise.all([
    supabase.from('revboxes').select('id, owner_id, shared').eq('workspace_id', workspaceId).in('id', boxIds),
    userId
      ? supabase.from('revbox_members').select('revbox_id, user_id, role').eq('workspace_id', workspaceId).eq('user_id', userId).in('revbox_id', boxIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (boxes.error) throw boxes.error;
  if (mine.error) throw mine.error;
  const byId = new Map((boxes.data ?? []).map(b => [b.id, b]));
  return new Map(jobs.map(j => [j.id, revboxAccess(byId.get(j.revbox_id) ?? null, userId, (mine.data ?? []).filter(m => m.revbox_id === j.revbox_id))]));
}
/** May the caller see this routine (and its runs)? Ordinary automations: yes, as before. */
export const canSeeRoutineRuns = (access, routineId) => !access.has(routineId) || !!access.get(routineId);
/** May the caller act on this routine's runs? A box job's needs its owner or an editor. */
export const canActOnRoutineRuns = (access, routineId) => !access.has(routineId) || ['owner', 'editor'].includes(access.get(routineId));
/** The box jobs the caller may not see. */
export const hiddenBoxJobs = (access) => [...access].filter(([, a]) => !a).map(([id]) => id);

/**
 * One routine, checked: null when the caller may go on (an ordinary routine, or a box job they may
 * see, and act on when `act`), else the refusal { status, body }: 404 when they cannot see the box,
 * 403 when they can see it but not edit it.
 */
export async function boxJobRefusal(supabase, workspaceId, userId, routineId, { act = false } = {}) {
  if (!routineId) return null;
  const access = await boxJobAccess(supabase, workspaceId, userId, { routineIds: [routineId] });
  if (!canSeeRoutineRuns(access, routineId)) return { status: 404, body: { error: 'not_found' } };
  if (act && !canActOnRoutineRuns(access, routineId)) {
    return { status: 403, body: { error: 'box_edit_required', message: 'Only an owner or editor of this RevBox can do that.' } };
  }
  return null;
}

/**
 * The /:runId check (an Express param handler) shared by /api and /v2 routes: next() for an
 * ordinary run (or one not found, which the route answers), 404 for a box job's run the caller
 * cannot see, 403 when the route acts on it (any method but GET) and they are not owner or editor.
 */
export const boxRunGuard = (userOf) => async (req, res, next, runId) => {
  try {
    const sb = getSupabaseClient();
    const { data: run, error } = await sb.from('agent_routine_runs').select('routine_id')
      .eq('id', runId).eq('workspace_id', req.workspaceId).maybeSingle();
    if (error && error.code !== '22P02') throw error;
    if (!run?.routine_id) return next();
    const no = await boxJobRefusal(sb, req.workspaceId, userOf(req), run.routine_id, { act: req.method !== 'GET' });
    if (no) return res.status(no.status).json(no.body.error === 'box_edit_required' ? { ...no.body, message: 'Only an owner or editor of this RevBox can act on its runs.' } : no.body);
    return next();
  } catch (err) {
    console.error('[box run check]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
};

/**
 * Usage per automation with the box jobs the caller may not see folded into one line: their
 * credits summed (so the total is unchanged), with no name, id or run count. Pure.
 */
export function foldPrivateBoxJobs(rows, access) {
  const hidden = new Set(hiddenBoxJobs(access));
  if (!hidden.size) return rows;
  const shown = rows.filter(r => !hidden.has(r.routine_id));
  const folded = rows.filter(r => hidden.has(r.routine_id));
  if (!folded.length) return rows;
  const line = { routine_id: null, name: PRIVATE_BOX_JOBS, runs: null, credits: folded.reduce((n, r) => n + (Number(r.credits) || 0), 0), private: true };
  return [...shown, line].sort((a, b) => b.credits - a.credits);
}
