// Routines another surface owns (GET-868, GET-910). The automation engine also runs routines on behalf
// of a Nous Cloud surface, kept as agent_routines rows like any automation. Such a row is managed only
// through its surface, which checks the caller's access to it: /api/automations and /v2/workflows
// neither list it nor open it by id, and its runs (and their approvals) are seen and acted on only by
// whom the surface allows. Cloud registers that rule at boot (registerRoutineAccess, from
// cloud/index.mjs); without one every routine is an ordinary automation and every check here lets the
// request through. Each check reads the rule when it runs, so the order of imports does not matter.

import { getSupabaseClient } from '@nous/core';

let rule = null;

/**
 * Plug in the owning surface's rule: { isOwned(row), columnMissing(error), excludeOwned(query),
 * ownsRoutine(supabase, workspaceId, id), access(supabase, workspaceId, userId, { routineIds }),
 * runGuard(userOf), fold(rows, access) }.
 */
export function registerRoutineAccess(impl) { rule = impl ?? null; }

/** Is this agent_routines row owned by another surface? Pure. */
export const isOwnedRoutine = (row) => !!rule?.isOwned(row);
/** The query error that means the owner's column is not there yet: then nothing is owned. */
export const ownerColumnMissing = (error) => !!rule?.columnMissing?.(error);
/** A select on agent_routines narrowed to ordinary automations. */
export const onlyOrdinaryRoutines = (query) => (rule ? rule.excludeOwned(query) : query);
/** Is routine `id` (of this workspace) owned by another surface? False when it is not there. */
export const ownsRoutine = (supabase, workspaceId, id) => (rule ? rule.ownsRoutine(supabase, workspaceId, id) : Promise.resolve(false));

/**
 * What the caller may do with each owned routine on this workspace: Map routineId -> a role, or null
 * when it is not theirs to see. A routine not in the map is an ordinary automation. Someone else's
 * personal RevPlay (GET-1087) is in it as false: not theirs to see, and not a surface's either.
 */
export async function routineAccess(supabase, workspaceId, userId, opts = {}) {
  const access = rule ? await rule.access(supabase, workspaceId, userId, opts) : new Map();
  let q = supabase.from('agent_routines').select('id, user_id').eq('workspace_id', workspaceId).eq('visibility', 'personal');
  if (opts.routineIds) q = q.in('id', opts.routineIds);
  const { data, error } = await q;
  if (error) { if (!['42703', 'PGRST204'].includes(error.code)) throw error; return access; }
  for (const r of data ?? []) if (!userId || r.user_id !== userId) access.set(r.id, false);
  return access;
}
/** May the caller see this routine (and its runs)? Ordinary automations: yes. */
export const canSeeRoutineRuns = (access, routineId) => !access.has(routineId) || !!access.get(routineId);
/** The owned routines the caller may not see. */
export const hiddenRoutines = (access) => [...access].filter(([, a]) => !a).map(([id]) => id);

/** The /:runId check (an Express param handler) for an owned or personal routine's runs; next() for any other. */
export const routineRunGuard = (userOf) => async (req, res, next, runId) => {
  try {
    const { data: run } = await getSupabaseClient().from('agent_routine_runs').select('routine_id').eq('id', runId).maybeSingle();
    if (run?.routine_id) {
      const access = await routineAccess(getSupabaseClient(), req.workspaceId, userOf(req), { routineIds: [run.routine_id] });
      if (access.get(run.routine_id) === false) return res.status(404).json({ error: 'not_found' });
    }
  } catch (err) {
    console.error('[routineRunGuard]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
  return rule ? rule.runGuard(userOf)(req, res, next, runId) : next();
};

/** Usage per automation with the owned routines the caller may not see folded into one line (the rule's). */
export function foldHiddenRoutines(rows, access) {
  const theirs = new Set([...access].filter(([, a]) => a === false).map(([id]) => id));
  const folded = rows.filter(r => theirs.has(r.routine_id));
  const shown = theirs.size ? rows.filter(r => !theirs.has(r.routine_id)) : rows;
  const out = rule?.fold ? rule.fold(shown, new Map([...access].filter(([, a]) => a !== false))) : shown;
  if (!folded.length) return out;
  const line = { routine_id: null, name: "Teammates' personal RevPlays", runs: null, credits: folded.reduce((n, r) => n + (Number(r.credits) || 0), 0) };
  return [...out, line].sort((a, b) => b.credits - a.credits);
}
