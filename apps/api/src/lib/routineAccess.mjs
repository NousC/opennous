// Routines another surface owns (GET-868, GET-910). The automation engine also runs routines on behalf
// of a Nous Cloud surface, kept as agent_routines rows like any automation. Such a row is managed only
// through its surface, which checks the caller's access to it: /api/automations and /v2/workflows
// neither list it nor open it by id, and its runs (and their approvals) are seen and acted on only by
// whom the surface allows. Cloud registers that rule at boot (registerRoutineAccess, from
// cloud/index.mjs); without one every routine is an ordinary automation and every check here lets the
// request through. Each check reads the rule when it runs, so the order of imports does not matter.

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
 * when it is not theirs to see. A routine not in the map is an ordinary automation.
 */
export const routineAccess = (supabase, workspaceId, userId, opts = {}) => (rule ? rule.access(supabase, workspaceId, userId, opts) : Promise.resolve(new Map()));
/** May the caller see this routine (and its runs)? Ordinary automations: yes. */
export const canSeeRoutineRuns = (access, routineId) => !access.has(routineId) || !!access.get(routineId);
/** The owned routines the caller may not see. */
export const hiddenRoutines = (access) => [...access].filter(([, a]) => !a).map(([id]) => id);

/** The /:runId check (an Express param handler) for an owned routine's runs; next() for any other. */
export const routineRunGuard = (userOf) => (req, res, next, runId) => (rule ? rule.runGuard(userOf)(req, res, next, runId) : next());

/** Usage per automation with the owned routines the caller may not see folded into one line (the rule's). */
export const foldHiddenRoutines = (rows, access) => (rule?.fold ? rule.fold(rows, access) : rows);
