// Personal and shared RevPlays (GET-1087), the one rule behind /api/automations, /v2/workflows and
// /v2/rev-plays. Pure.
//
//   shared    every member sees it and its runs; admins edit it. What every row was before this.
//   personal  only its owner (user_id) sees, edits and runs it. Any member may make one, on a closed
//             workspace too. Admins cannot see or edit it: nothing in the product needs them to, and
//             it stops running by itself when its owner leaves (dropStoppedRoutines).
//
// Only an admin shares. A key with no person (a workspace key) owns nothing, so it never sees a
// personal play; with admin scope it still manages the shared ones, as it always has.
export const PERSONAL = 'personal';
export const SHARED = 'shared';

export const isPersonal = (row) => row?.visibility === PERSONAL;

/** Who is asking, from either auth path. */
export function viewerOf(req) {
  return { userId: req.noContent ? null : req.memberUserId ?? req.internalUserId ?? null, admin: req.viewerScope === 'admin' };
}

export const canSeeRoutine = (row, viewer) => !isPersonal(row) || (!!viewer.userId && row.user_id === viewer.userId);
export const canEditRoutine = (row, viewer) => (isPersonal(row) ? canSeeRoutine(row, viewer) : viewer.admin);

const ADMIN_ONLY = { status: 403, body: { error: 'admin_required', message: 'Only an admin can share a RevPlay with the team.' } };
const READ_ONLY = { status: 403, body: { error: 'rev_play_read_only', message: 'This RevPlay is shared with the team. Only an admin can change it.' } };
export const readOnlyRefusal = () => READ_ONLY;

/** The visibility a new row gets: personal, unless an admin shares it or the key has no person. */
export function createVisibility(requested, viewer) {
  if (requested !== undefined && requested !== PERSONAL && requested !== SHARED) {
    return { fail: { status: 400, body: { error: 'invalid_visibility', supported: [PERSONAL, SHARED] } } };
  }
  if (requested === SHARED && !viewer.admin) return { fail: ADMIN_ONLY };
  if (requested === PERSONAL && !viewer.userId) {
    return { fail: { status: 400, body: { error: 'member_required', message: 'A personal RevPlay belongs to a person: use a member API key.' } } };
  }
  return { visibility: requested ?? (viewer.userId ? PERSONAL : SHARED) };
}

/** Why this change of visibility is refused, or null. Sharing and unsharing are an admin's, on a row they can see. */
export function visibilityChange(row, requested, viewer) {
  if (requested !== PERSONAL && requested !== SHARED) return { status: 400, body: { error: 'invalid_visibility', supported: [PERSONAL, SHARED] } };
  if (!viewer.admin) return ADMIN_ONLY;
  // A shared play taken back has to be someone's: only the person who made it can take it.
  if (requested === PERSONAL && row.user_id !== viewer.userId) return READ_ONLY;
  return null;
}

/** What a client needs to draw a row. */
export const visibilityFields = (row, viewer) => ({
  visibility: row.visibility ?? SHARED,
  yours: !!viewer.userId && row.user_id === viewer.userId,
  can_edit: canEditRoutine(row, viewer),
  can_share: viewer.admin && isPersonal(row) && row.user_id === viewer.userId,
});
